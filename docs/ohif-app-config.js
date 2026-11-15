// OHIF v3 DICOMweb data source (development template only).
// Serve this file as the OHIF configuration after deploying an authenticated
// SAME-ORIGIN reverse proxy in front of /dicomweb. Do not place API_TOKEN here.
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
