// OHIF v3 DICOMweb data source (development template only).
// Served by the loopback lab in src/ohif-dev.js. A shared deployment requires
// its own authenticated, same-origin reverse proxy. Never place API_TOKEN here.
window.config = {
  routerBasename: '/',
  extensions: [],
  modes: [],
  showStudyList: true,
  dataSources: [{
    namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
    sourceName: 'nativePacs',
    configuration: {
      friendlyName: 'Native PACS — Development',
      name: 'Native PACS',
      qidoRoot: window.location.origin + '/dicomweb',
      wadoRoot: window.location.origin + '/dicomweb',
      stowRoot: window.location.origin + '/dicomweb',
      qidoSupportsIncludeField: false,
      supportsFuzzyMatching: false,
      supportsWildcard: false,
      supportsReject: false,
      imageRendering: 'wadors',
      thumbnailRendering: 'wadors',
      enableStudyLazyLoad: true
    }
  }],
  defaultDataSourceName: 'nativePacs'
};
