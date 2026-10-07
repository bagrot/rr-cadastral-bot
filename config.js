module.exports = {
  cdpUrl: 'http://127.0.0.1:9222',
  sheetsUrl: '',
  nspdUrl: 'https://nspd.gov.ru/map?thematic=PKK&theme_id=1&baseLayerId=235&is_copy_url=true&zoom=5&coordinate_x=7804891.637510094&coordinate_y=8181287.398947453',
  rosreestrUrl: 'https://lk.rosreestr.ru/eservices/real-estate-objects-online',

  connectTimeoutMs: 120000,
  cdpAttemptTimeoutMs: 30000,
  cdpConnectRetries: 3,
  pageReadyTimeoutMs: 45000,
  shortWaitMs: 250,
  afterClickWaitMs: 850,

  sheetReadRetries: 5,
  sheetReadDelayMs: 220,
  sheetPasteWaitMs: 700,

  nspdSearchWaitMs: 12000,
  nspdCardWaitMs: 1800,
  nspdScrollPauseMs: 180,
  nspdMaxScrollPasses: 900,
  nspdObjectOpenRetries: 1,
  nspdUseApiForObjectDetails: true,
  nspdApiBatchSize: 60,
  // Шесть параллельных запросов ускоряют первый сбор. Общая очередь
  // автоматически пережидает 429/5xx от НСПД и не создаёт новый шторм.
  nspdApiConcurrency: 6,
  nspdApiRequestSpacingMs: 180,
  nspdServerErrorRetryCount: 3,
  nspdCacheFile: 'nspd-cache.json',
  nspdCacheTtlHours: 24,
  nspdMissingCacheTtlHours: 3,

  rosreestrNotFoundRetryCount: 5,
  rosreestrBetweenRetriesMs: 700,
  rosreestrHumanPauseMinMs: 650,
  rosreestrHumanPauseMaxMs: 1200,
  rosreestrOutcomeWaitMs: 14000,
  rosreestrCardWaitMs: 7000,
  rosreestrUseApi: true,
  // Росреестр начинает отвечать 503 при более частых запросах. Интервал
  // динамически растёт после 503 и больше не опускается ниже этого порога.
  rosreestrApiMinIntervalMs: 1800,
  rosreestrApiRetryCount: 6,
  rosreestrApiBackoffMs: 1800,
  rosreestrSheetWriteChunkSize: 10,
  rosreestrMassFailureReloadThreshold: 3,
  rosreestrReloadWaitMs: 5000,
  rosreestrAfterReloadIntervalMs: 3500,

  gisUrl: 'https://dom.gosuslugi.ru/#!/houses',
  gisPassportWaitMs: 5000,
  gisUseApi: true,
  gisRegionByCadPrefix: {
    '77': 'Москва',
    '50': 'Московская область'
  },

  commonPropertyColor: '#fff2cc',
  nonResidentialNoOwnershipColor: '#fce4ec',
  maxObjectsPerRun: 2000,
  sheetWriteChunkSize: 100,
  nspdCheckCommonPropertyOnlyForNonResidential: true,
  jobStateFile: 'last-job-state.json'
};
