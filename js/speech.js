// ORIANE — synthèse vocale (file avec priorités) et reconnaissance vocale.
//
// v2.2-0, voix muette sur Android : deux défauts de Chrome sont contournés.
// 1. Moteur bloqué : après une phrase coupée ou un passage en arrière-plan, speechSynthesis peut rester
//    « en cours » sans jamais parler ; toutes les phrases suivantes sont alors muettes. Si une phrase n'a
//    pas démarré au bout de 3 s : cancel(), puis nouvel essai (avec le moteur par défaut du téléphone).
//    Le moteur est aussi relancé (resume) s'il est en pause.
// 2. Micro occupé : avec « Dis Oriane », la voix attend que l'écoute soit vraiment arrêtée (beforeSpeak).

/**
 * File de messages parlés.
 * priority : 1 = information, 2 = guidage, 3 = alerte (coupe une information en cours).
 * key : remplace les messages en attente portant la même clé.
 * say() renvoie une promesse résolue quand le message a été dit (ou abandonné).
 */
export class Voice {
  constructor() {
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.rate = 1.05;
    this.queue = [];
    this.current = null;
    this.voice = null;
    this.onstate = null;
    this.onsay = null;
    this._token = 0;
    this.voices = [];
    this.preferredURI = '';
    this.onerror = null; // (code, texte) : échec de la synthèse
    this.onrecover = null; // (code, texte) : phrase muette rattrapée par un nouvel essai
    this.beforeSpeak = null; // async () : à attendre avant de parler (libérer le micro)
    this.failures = 0;
    this.successes = 0;
    this.recoveries = 0;
    this.startTimeout = 3000; // ms sans démarrage avant de relancer le moteur
    if (this.supported) {
      const load = () => {
        this.voices = speechSynthesis.getVoices();
        this.pick();
        this.onvoices?.(this.voices);
      };
      load();
      speechSynthesis.addEventListener?.('voiceschanged', load);
    }
  }

  /** Voix françaises disponibles (locales d'abord : elles marchent sans réseau). */
  get frenchVoices() {
    return this.voices
      .filter((v) => /^fr/i.test(v.lang))
      .sort((a, b) => Number(b.localService) - Number(a.localService) || Number(/fr[-_]FR/i.test(b.lang)) - Number(/fr[-_]FR/i.test(a.lang)));
  }

  /** Choisit la voix : celle demandée, sinon une voix française locale, sinon aucune (moteur par défaut). */
  pick() {
    const pref = this.preferredURI && this.voices.find((v) => v.voiceURI === this.preferredURI);
    if (pref) return (this.voice = pref);
    if (this.preferredURI === 'system') return (this.voice = null);
    this.voice = this.frenchVoices[0] || null;
    return this.voice;
  }

  setPreferred(uri) {
    this.preferredURI = uri || '';
    this.pick();
  }

  diagnose() {
    return {
      supported: this.supported,
      total: this.voices.length,
      french: this.frenchVoices.map((v) => `${v.name} (${v.lang}${v.localService ? ', locale' : ', en ligne'})`),
      chosen: this.voice ? `${this.voice.name} (${this.voice.lang})` : 'moteur par défaut du téléphone',
      failures: this.failures,
      successes: this.successes,
      recoveries: this.recoveries,
      engine: this.engineState(),
    };
  }

  /** État du moteur de Chrome, pour le journal. */
  engineState() {
    if (!this.supported) return 'absent';
    const ss = speechSynthesis;
    return `parle ${ss.speaking ? 'oui' : 'non'}, en attente ${ss.pending ? 'oui' : 'non'}, en pause ${ss.paused ? 'oui' : 'non'}`;
  }

  say(text, { priority = 1, interrupt = false, key = null } = {}) {
    return new Promise((resolve) => {
      this.onsay?.(text);
      if (!this.supported) return resolve();
      if (interrupt) this._flush();
      if (key) {
        this.queue = this.queue.filter((it) => {
          if (it.key === key) {
            it.resolve();
            return false;
          }
          return true;
        });
      }
      const item = { text, priority, key, resolve };
      let i = this.queue.findIndex((it) => it.priority < priority);
      if (i < 0) i = this.queue.length;
      this.queue.splice(i, 0, item);
      // Une alerte (priorité 3) coupe un message moins prioritaire en cours.
      if (this.current && priority >= 3 && this.current.priority < priority) this._cancelCurrent();
      // Évite l'accumulation de vieux messages d'information.
      while (this.queue.length > 4) {
        const idx = this.queue.map((q) => q.priority).lastIndexOf(1);
        if (idx < 0) break;
        this.queue.splice(idx, 1)[0].resolve();
      }
      this._next();
    });
  }

  get speaking() {
    return !!this.current;
  }

  stop() {
    this._flush();
  }

  _flush() {
    for (const it of this.queue) it.resolve();
    this.queue = [];
    if (this.current) this._cancelCurrent();
  }

  /** Coupe la phrase en cours ; si elle attend encore le micro, elle est abandonnée sans être dite. */
  _cancelCurrent() {
    if (this._waiting) {
      const it = this.current;
      this._token++;
      this._waiting = false;
      this.current = null;
      it.resolve();
      this.onstate?.(false);
    } else speechSynthesis.cancel();
  }

  async _next() {
    if (this.current || !this.queue.length) return;
    const item = this.queue.shift();
    this.current = item;
    const token = ++this._token;
    this.onstate?.(true);
    // Mains libres : attendre que le micro soit libéré avant de parler (borné par l'appelant).
    if (this.beforeSpeak) {
      this._waiting = true;
      try {
        await this.beforeSpeak();
      } catch {
        /* on parle quand même */
      }
      if (this._token !== token || this.current !== item) return;
      this._waiting = false;
    }
    this._speak(item, token, 0);
  }

  /** Fin d'une phrase (dite, abandonnée ou en échec) : passe à la suivante. */
  _done(item, token) {
    if (this._token !== token || this.current !== item) return;
    this.current = null;
    item.resolve();
    this.onstate?.(false);
    setTimeout(() => this._next(), 80);
  }

  /** Un essai de la phrase ; attempt 1 = nouvel essai après un moteur bloqué. */
  _speak(item, token, attempt) {
    const ss = speechSynthesis;
    const alive = () => this._token === token && this.current === item && !att.stale;
    const att = { stale: false };
    if (ss.paused) ss.resume();
    const u = new SpeechSynthesisUtterance(item.text);
    u.lang = 'fr-FR';
    // Nouvel essai : moteur par défaut du téléphone, au cas où la voix choisie serait en cause.
    if (this.voice && attempt === 0) u.voice = this.voice;
    u.rate = this.rate;
    let started = false;
    let endTimer = null;
    const finish = () => {
      if (!alive()) return;
      att.stale = true;
      clearTimeout(endTimer);
      clearTimeout(startTimer);
      this._done(item, token);
    };
    const retryOrFail = (code) => {
      if (!alive()) return;
      att.stale = true;
      clearTimeout(endTimer);
      clearTimeout(startTimer);
      if (attempt === 0) {
        this.recoveries++;
        this.onrecover?.(code, item.text);
        ss.cancel(); // débloque la file de Chrome
        setTimeout(() => {
          if (this._token === token && this.current === item) this._speak(item, token, 1);
        }, 250);
      } else {
        this.failures++;
        this.onerror?.(code, item.text);
        ss.cancel();
        this._done(item, token);
      }
    };
    u.onstart = () => {
      if (!alive()) return;
      started = true;
      clearTimeout(startTimer);
      this.successes++;
      // Filet de sécurité : Chrome Android oublie parfois l'événement de fin.
      endTimer = setTimeout(finish, 2500 + (item.text.length * 110) / this.rate);
    };
    u.onend = finish;
    u.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return finish();
      if (started) {
        this.failures++;
        this.onerror?.(e.error || 'erreur', item.text);
        return finish();
      }
      retryOrFail(e.error || 'erreur');
    };
    // Aucune voix n'a démarré : moteur bloqué, voix absente… → nouvel essai, puis échec signalé.
    const startTimer = setTimeout(() => {
      if (!started) retryOrFail('no-start');
    }, this.startTimeout);
    ss.speak(u);
  }
}

export const hasRecognition =
  typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);

/** Écoute une phrase en français. Renvoie les transcriptions possibles (tableau, éventuellement vide). */
export function listen({ timeout = 9000 } = {}) {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return reject(new Error('reconnaissance vocale non disponible dans ce navigateur'));
    const r = new SR();
    r.lang = 'fr-FR';
    r.interimResults = false;
    r.maxAlternatives = 3;
    let finished = false;
    const finish = (fn) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fn();
    };
    r.onresult = (e) => finish(() => resolve([...e.results[0]].map((a) => a.transcript.trim())));
    r.onerror = (e) =>
      finish(() => (e.error === 'no-speech' || e.error === 'aborted' ? resolve([]) : reject(new Error(e.error))));
    r.onend = () => finish(() => resolve([]));
    const timer = setTimeout(() => {
      try {
        r.stop();
      } catch {
        /* déjà arrêtée */
      }
    }, timeout);
    try {
      r.start();
    } catch (err) {
      finish(() => reject(err));
    }
  });
}
