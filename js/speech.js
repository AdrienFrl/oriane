// ORIANE — synthèse vocale (file avec priorités) et reconnaissance vocale.

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
    if (this.supported) {
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this.voice =
          vs.find((v) => /^fr[-_]FR/i.test(v.lang) && /google/i.test(v.name)) ||
          vs.find((v) => /^fr[-_]FR/i.test(v.lang)) ||
          vs.find((v) => /^fr/i.test(v.lang)) ||
          null;
      };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
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
      // Une alerte coupe une simple information en cours.
      if (this.current && priority >= 3 && this.current.priority <= 1) speechSynthesis.cancel();
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
    if (this.current) speechSynthesis.cancel();
  }

  _next() {
    if (this.current || !this.queue.length) return;
    const item = this.queue.shift();
    this.current = item;
    const token = ++this._token;
    const u = new SpeechSynthesisUtterance(item.text);
    u.lang = 'fr-FR';
    if (this.voice) u.voice = this.voice;
    u.rate = this.rate;
    const done = () => {
      if (this._token !== token || this.current !== item) return;
      this.current = null;
      item.resolve();
      this.onstate?.(false);
      setTimeout(() => this._next(), 80);
    };
    u.onend = done;
    u.onerror = done;
    this.onstate?.(true);
    speechSynthesis.speak(u);
    // Filet de sécurité : Chrome Android oublie parfois l'événement de fin.
    setTimeout(done, 2500 + (item.text.length * 110) / this.rate);
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
