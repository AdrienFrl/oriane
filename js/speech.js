// ORIANE — synthèse vocale (file avec priorités) et reconnaissance vocale.
//
// Voix (v2.2-0.1, retour au principe de la v1 qui fonctionnait sur le téléphone) :
// - par défaut, la voix française « Google » de Chrome si elle est listée ; sinon AUCUNE voix imposée :
//   la phrase est envoyée en fr-FR et Chrome parle avec sa voix française par défaut. Une liste de voix
//   vide (fréquent sur Android) n'empêche donc jamais de parler ;
// - une phrase n'est jamais coupée parce que Chrome n'a pas signalé son début (certains Android ne le
//   font pas) : seuls la fin, une vraie erreur ou le filet de sécurité terminent une phrase ;
// - vraie erreur avant le début avec une voix imposée : un nouvel essai sans voix imposée ;
// - moteur en pause (arrière-plan) : relancé ; « Dis Oriane » : la voix attend que le micro soit libéré.

/** Voix « Google » en français (celle de Chrome), en fr-FR de préférence. */
export function googleFrenchVoice(voices) {
  const fr = voices.filter((v) => /^fr/i.test(v.lang) && /google/i.test(v.name));
  return fr.find((v) => /^fr[-_]FR/i.test(v.lang)) || fr[0] || null;
}

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
    this.onrecover = null; // (code, texte) : erreur rattrapée par un nouvel essai sans voix imposée
    this.beforeSpeak = null; // async () : à attendre avant de parler (libérer le micro)
    this.failures = 0;
    this.successes = 0;
    this.recoveries = 0;
    if (this.supported) {
      const load = () => {
        this.voices = speechSynthesis.getVoices() || [];
        this.pick();
        this.onvoices?.(this.voices);
      };
      load();
      speechSynthesis.addEventListener?.('voiceschanged', load);
    }
  }

  /** Voix françaises listées par Chrome (Google d'abord). */
  get frenchVoices() {
    return this.voices
      .filter((v) => /^fr/i.test(v.lang))
      .sort((a, b) => Number(/google/i.test(b.name)) - Number(/google/i.test(a.name)) || Number(/^fr[-_]FR/i.test(b.lang)) - Number(/^fr[-_]FR/i.test(a.lang)));
  }

  /**
   * Choisit la voix : celle demandée dans les réglages si elle existe ; sinon (automatique) la voix
   * Google française ; sinon aucune (Chrome choisit sa voix française par défaut).
   */
  pick() {
    const pref = this.preferredURI && this.preferredURI !== 'system' && this.voices.find((v) => v.voiceURI === this.preferredURI);
    if (pref) return (this.voice = pref);
    if (this.preferredURI === 'system') return (this.voice = null);
    this.voice = googleFrenchVoice(this.voices);
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
      chosen: this.voice ? `${this.voice.name} (${this.voice.lang})` : 'voix française par défaut de Chrome',
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

  /**
   * À appeler lors d'un appui de l'utilisateur : Chrome sur Android n'autorise la voix qu'après un
   * geste. Une phrase vide et muette « déverrouille » la synthèse pour les annonces suivantes.
   */
  unlock() {
    if (!this.supported || this._unlocked) return;
    this._unlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      u.lang = 'fr-FR';
      speechSynthesis.speak(u);
    } catch {
      /* sans conséquence */
    }
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
    this._speak(item, token, this.voice);
  }

  /** Fin d'une phrase (dite, abandonnée ou en échec) : passe à la suivante. */
  _done(item, token) {
    if (this._token !== token || this.current !== item) return;
    this.current = null;
    item.resolve();
    this.onstate?.(false);
    setTimeout(() => this._next(), 80);
  }

  /** Un essai de la phrase, avec la voix donnée (null = voix française par défaut de Chrome). */
  _speak(item, token, voice) {
    const ss = speechSynthesis;
    const att = { over: false };
    const alive = () => !att.over && this._token === token && this.current === item;
    if (ss.paused) ss.resume();
    const u = new SpeechSynthesisUtterance(item.text);
    u.lang = 'fr-FR';
    if (voice) u.voice = voice;
    u.rate = this.rate;
    let started = false;
    const finish = () => {
      if (!alive()) return;
      att.over = true;
      clearTimeout(safety);
      this._done(item, token);
    };
    u.onstart = () => {
      if (!alive()) return;
      started = true;
      this.successes++;
    };
    u.onend = finish;
    u.onerror = (e) => {
      if (!alive()) return;
      const code = e.error || 'erreur';
      if (code === 'interrupted' || code === 'canceled') return finish();
      // Vraie erreur avant le début avec une voix imposée : nouvel essai avec la voix de Chrome.
      if (!started && voice) {
        att.over = true;
        clearTimeout(safety);
        this.recoveries++;
        this.onrecover?.(code, item.text);
        setTimeout(() => {
          if (this._token === token && this.current === item) this._speak(item, token, null);
        }, 150);
        return;
      }
      this.failures++;
      this.onerror?.(code, item.text);
      finish();
    };
    ss.speak(u);
    // Filet de sécurité (comme en v1) : Chrome Android oublie parfois l'événement de fin.
    // La phrase n'est pas coupée : on passe seulement à la suivante dans notre file.
    const safety = setTimeout(finish, 2500 + (item.text.length * 110) / this.rate);
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
