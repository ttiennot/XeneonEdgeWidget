'use strict';

/**
 * Accès au plugin « Sensors » d'iCUE (widgetbuilder.sensorsdataprovider) sous forme de promesses.
 * Le plugin répond de façon asynchrone via le signal asyncResponse(requestId, value).
 */
(function () {
  var plugin = null;
  var nextId = 1;
  var pending = {};
  var valueListeners = [];
  var readyCallbacks = [];

  function onReady() {
    if (plugin || !window.plugins || !window.plugins.Sensorsdataprovider) return;
    plugin = window.plugins.Sensorsdataprovider;
    plugin.asyncResponse.connect(function (id, value) {
      var p = pending[id];
      if (!p) return;
      delete pending[id];
      clearTimeout(p.timer);
      p.resolve(value);
    });
    plugin.sensorValueChanged.connect(function (sensorId, value) {
      valueListeners.forEach(function (cb) { cb(sensorId, value); });
    });
    readyCallbacks.splice(0).forEach(function (cb) { cb(); });
  }

  function call(method, args) {
    if (!plugin) return Promise.reject(new Error('Plugin capteurs indisponible'));
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = {
        resolve: resolve,
        timer: setTimeout(function () {
          delete pending[id];
          reject(new Error('Délai dépassé (capteurs iCUE)'));
        }, 5000),
      };
      plugin[method].apply(plugin, [id].concat(args || []));
    });
  }

  window.pluginSensorsdataproviderEvents = { onInitialized: onReady };
  if (window.pluginSensorsdataprovider_initialized) onReady();

  window.IcueSensors = {
    available: function () { return !!plugin; },
    whenReady: function (cb) { if (plugin) cb(); else readyCallbacks.push(cb); },
    value: function (id) { return call('getSensorValue', [id]); },
    units: function (id) { return call('getSensorUnits', [id]); },
    deviceName: function (id) { return call('getSensorDeviceName', [id]); },
    onValue: function (cb) { valueListeners.push(cb); },
  };
})();
