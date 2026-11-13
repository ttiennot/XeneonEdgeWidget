'use strict';

/*
 * Widget iCUE « Edge Deezer ».
 * La vue du widget navigue vers le lecteur web de Deezer (Deezer interdit l'affichage en iframe).
 * La session est conservée par la vue web d'iCUE.
 */
(function () {
  var Edge = window.Edge;
  var timer = null;

  function playerUrl() {
    var url = String(Edge.prop('deezerUrl', '') || '').trim();
    // N'accepte que des pages Deezer (évite de transformer le widget en navigateur).
    return /^https:\/\/([a-z0-9-]+\.)?deezer\.com(\/|$)/i.test(url) ? url : 'https://www.deezer.com/';
  }

  function openPlayer() {
    clearTimeout(timer);
    window.location.href = playerUrl();
  }

  function update() {
    Edge.applyTheme();
    clearTimeout(timer);
    document.getElementById('help').textContent = Edge.t('deezerHelp');
    document.getElementById('open').textContent = Edge.t('openDeezer');
    // Pas de navigation automatique dans l'aperçu d'iCUE ni dans un navigateur classique.
    var preview = !Edge.inIcue || (window.iCUE && window.iCUE.isPreview);
    if (Edge.boolProp('autoOpen', true) && !preview) timer = setTimeout(openPlayer, 1200);
  }

  Edge.start({
    init: function () {
      document.getElementById('open').addEventListener('click', openPlayer);
    },
    update: update,
  });
})();
