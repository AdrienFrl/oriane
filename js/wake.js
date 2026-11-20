// ORIANE v2 — écoute mains libres du mot d'activation « Dis Oriane ».
// Utilise la reconnaissance vocale continue de Chrome. Limites connues du navigateur :
// l'écoute s'arrête quand l'écran est éteint, et Android peut émettre un petit son à chaque relance.

export const WAKE_RE = /\b(?:dis|dit|di|dix|dites)\s*,?\s*(?:oriane|orianne|oriana|ariane|ariana|orianna)\b[\s,.:!]*/i;

/** Renvoie la commande qui suit le mot d'activation ('' s'il n'y en a pas), ou null si absent. */
export function extractWake(text) {
  const m = WAKE_RE.exec(text);
  if (!m) return null;
  return text.slice(m.index + m[0].length).trim();
}

export class WakeWord {
  constructor({ onWake, onError, log }) {
    Object.assign(this, { onWake, onError, log });
    this.active = false;
    this.blockers = new Set();
    this.rec = null;
    this.timer = null;
    this.endWaiters = [];
  }

  /**
   * Promesse résolue quand l'écoute est vraiment arrêtée (micro libéré), au plus tard après maxMs.
   * Sur Android, parler pendant que le micro est encore ouvert peut rendre la voix muette.
   */
  release(maxMs = 400) {
    if (!this.rec) return Promise.resolve();
    try {
      this.rec.abort();
    } catch {
      /* déjà arrêtée */
    }
    return new Promise((resolve) => {
      const t = setTimeout(resolve, maxMs);
      this.endWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  static get supported() {
    return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start() {
    if (!WakeWord.supported) return false;
    this.active = true;
    this._listen();
    return true;
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    try {
      this.rec?.abort();
    } catch {
      /* déjà arrêtée */
    }
    this.rec = null;
  }

  /** Suspend l'écoute (voix en cours, écoute d'une commande…). */
  block(reason) {
    this.blockers.add(reason);
    try {
      this.rec?.abort();
    } catch {
      /* déjà arrêtée */
    }
  }

  unblock(reason) {
    this.blockers.delete(reason);
    this._soon(500);
  }

  _soon(ms = 400) {
    clearTimeout(this.timer);
    if (this.active && !this.blockers.size && !this.rec) this.timer = setTimeout(() => this._listen(), ms);
  }

  _listen() {
    if (!this.active || this.blockers.size || this.rec) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new SR();
    r.lang = 'fr-FR';
    r.continuous = true;
    r.interimResults = false;
    r.maxAlternatives = 2;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        for (const alt of e.results[i]) {
          const rest = extractWake(alt.transcript);
          if (rest == null) continue;
          this.log?.('🎙 Mot d’activation entendu : « ' + alt.transcript.trim() + ' »');
          try {
            r.abort();
          } catch {
            /* déjà arrêtée */
          }
          this.onWake?.(rest);
          return;
        }
      }
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.active = false;
        this.onError?.('micro refusé');
      }
    };
    r.onend = () => {
      if (this.rec === r) {
        this.rec = null;
        const w = this.endWaiters.splice(0);
        for (const f of w) f();
      }
      this._soon();
    };
    try {
      r.start();
      this.rec = r;
    } catch {
      this.rec = null;
      this._soon(1000);
    }
  }
}
