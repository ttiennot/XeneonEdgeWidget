'use strict';

/**
 * Boutons « micro » et « casque » de Discord, avec leur état réel.
 *
 *   { "type": "discordVoice", "control": "mute" }   micro
 *   { "type": "discordVoice", "control": "deaf" }   casque (sourdine)
 *
 * Ils passent par la liaison avec l'application Discord (voir discord-voice.js), donc ils
 * fonctionnent aussi en plein jeu, sans raccourci clavier, et affichent l'état de Discord.
 *
 * Options : labels { on: { label, icon, color }, off: { label, icon, color } }
 *   on  = micro / casque actif (le bouton propose de couper)
 *   off = coupé (le bouton propose de rétablir)
 */

const DEFAULTS = {
  mute: {
    on: { label: 'Couper micro', icon: '🎙️', color: '#8f1f1f' },
    off: { label: 'Rétablir micro', icon: '🎙️', color: '#1f6f3a' },
  },
  deaf: {
    on: { label: 'Couper casque', icon: '🎧', color: '#8f1f1f' },
    off: { label: 'Rétablir casque', icon: '🎧', color: '#1f6f3a' },
  },
};

const STATUS_ERRORS = {
  unconfigured: 'Application Discord non configurée (discordVoice dans config.json)',
  'no-discord': 'Discord n’est pas lancé',
  unauthorized: 'Autorisez l’accès à Discord depuis le widget Edge Voice',
  authorizing: 'Autorisation Discord en attente',
};

/** @param {() => object|null} getVoice service renvoyé par createDiscordVoice */
function createVoiceControl(getVoice) {
  const controlOf = (action) => (action && action.control === 'deaf' ? 'deaf' : 'mute');

  const ready = () => {
    const voice = getVoice && getVoice();
    if (!voice) throw new Error('Vocal Discord indisponible');
    const snap = voice.snapshot();
    if (snap.status !== 'ready') throw new Error(STATUS_ERRORS[snap.status] || 'Discord n’est pas connecté');
    return { voice, snap };
  };

  const describe = (action, snap) => {
    const control = controlOf(action);
    // Casque coupé : Discord coupe aussi le micro.
    const cut = control === 'deaf' ? !!snap.deaf : !!(snap.mute || snap.deaf);
    const name = cut ? 'off' : 'on';
    const base = DEFAULTS[control][name];
    const custom = (action && action.labels && action.labels[name]) || {};
    const part = typeof custom === 'string' ? { label: custom } : custom;
    return { cut, index: cut ? 1 : 0, label: part.label || base.label, icon: part.icon || base.icon, color: part.color || base.color };
  };

  return {
    state: async (action) => describe(action, ready().snap),
    run: async (action) => {
      const { voice } = ready();
      if (controlOf(action) === 'deaf') await voice.setDeaf();
      else await voice.setMute();
      return describe(action, voice.snapshot());
    },
  };
}

module.exports = { createVoiceControl };
