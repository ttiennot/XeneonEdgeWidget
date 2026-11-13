'use strict';

/*
 * Widget iCUE « Edge Discord ».
 *  - Client web : la vue du widget navigue vers discord.com (Discord interdit l'affichage en iframe).
 *    La session est conservée par la vue web d'iCUE.
 *  - Widget de serveur : iframe officielle https://discord.com/widget?id=<serveur>.
 */
(function () {
  var Edge = window.Edge;
  var timer = null;

  function clientUrl() {
    var url = String(Edge.prop('discordUrl', '') || '').trim();
    // N'accepte que des pages Discord (évite de transformer le widget en navigateur).
    return /^https:\/\/([a-z0-9-]+\.)?discord(app)?\.com\//i.test(url) ? url : 'https://discord.com/channels/@me';
  }

  function openClient() {
    clearTimeout(timer);
    window.location.href = clientUrl();
  }

  function showServer() {
    var id = String(Edge.prop('serverId', '') || '').replace(/\D/g, '');
    var frame = document.getElementById('server');
    var splash = document.getElementById('splash');
    if (!id) {
      frame.hidden = true;
      splash.hidden = false;
      document.getElementById('help').textContent = Edge.t('discordServerHelp');
      document.getElementById('open').hidden = true;
      return;
    }
    var src = 'https://discord.com/widget?id=' + id + '&theme=dark';
    if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
    frame.hidden = false;
    splash.hidden = true;
  }

  function update() {
    Edge.applyTheme();
    clearTimeout(timer);
    if (Edge.prop('discordMode', 'client') === 'server') return showServer();

    document.getElementById('server').hidden = true;
    document.getElementById('splash').hidden = false;
    document.getElementById('help').textContent = Edge.t('discordHelp');
    var btn = document.getElementById('open');
    btn.hidden = false;
    btn.textContent = Edge.t('openDiscord');
    // Pas de navigation automatique dans l'aperçu d'iCUE ni dans un navigateur classique.
    var preview = !Edge.inIcue || (window.iCUE && window.iCUE.isPreview);
    if (Edge.boolProp('autoOpen', true) && !preview) timer = setTimeout(openClient, 1200);
  }

  Edge.start({
    init: function () {
      document.getElementById('open').addEventListener('click', openClient);
    },
    update: update,
  });
})();
