(() => {
  'use strict';

  const BUILTIN_LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
    { code: 'ja', name: '日本語' },
  ];
  const LOCALE_STORAGE_KEY = 'pybot_custom_locales_v1';
  const SESSION_STORAGE_KEY = 'pybot_conversations_v1';
  const THEME_STORAGE_KEY = 'pybot_theme_v1';
  const COMMAND_PACKAGE_STORAGE_KEY = 'pybot_command_packages_v1';
  const COMMAND_PACKAGE_FORMAT = 'pybot-command-package';
  const MAX_COMMANDS_PER_PACKAGE = 12;
  const MAX_RUNTIME_COMMANDS = 20;
  const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'yi']);
  const COMMAND_MARKS = (() => {
    try { return new RegExp('[\\p{P}\\p{S}]', 'gu'); }
    catch (_) { return /[.,!?;:()[\]{}"“”‘’…—–\\/-]/g; }
  })();

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  let sessionSearchTimer = null;
  const state = {
    builtins: {},
    english: {},
    locale: {},
    languageCatalog: [],
    customLocales: [],
    commandPackages: [],
    cortexStatus: null,
    cortexModels: [],
    selectedModel: '',
    language: 'en',
    theme: 'dark',
    sessions: [],
    activeId: null,
    pending: false,
    typingFor: null,
    recognition: null,
    recognitionActive: false,
  };

  const els = {
    languageSelect: $('#language-select'),
    addLanguage: $('#add-language'),
    languageDialog: $('#language-dialog'),
    languageForm: $('#language-form'),
    languageName: $('#language-name'),
    languageCode: $('#language-code'),
    languageCodeSuggestions: $('#language-code-suggestions'),
    languageJson: $('#language-json'),
    languageError: $('#language-error'),
    languageFile: $('#language-file'),
    templateButton: $('#download-template'),
    themeToggle: $('#theme-toggle'),
    newChat: $('#new-chat'),
    packageBuilderButton: $('#package-builder-button'),
    packageCount: $('#package-count'),
    packageDialog: $('#package-dialog'),
    packageForm: $('#package-form'),
    packageName: $('#package-name'),
    packageLanguageSearch: $('#package-language-search'),
    packageLanguageSelect: $('#package-language-select'),
    commandEditorList: $('#command-editor-list'),
    packageError: $('#package-error'),
    addPackageCommand: $('#add-package-command'),
    downloadCommandPackage: $('#download-command-package'),
    packageFile: $('#package-file'),
    installedPackageList: $('#installed-package-list'),
    installedPackagesEmpty: $('#installed-packages-empty'),
    installedPackageCount: $('#installed-package-count'),
    providerTitle: $('#assistant-provider-title'),
    providerBody: $('#assistant-provider-body'),
    modelSelect: $('#cortex-model-select'),
    sessionList: $('#session-list'),
    sessionEmpty: $('#session-empty'),
    sessionSearchEmpty: $('#session-search-empty'),
    sessionSearch: $('#session-search'),
    sessionCount: $('#session-count'),
    exportConversation: $('#export-conversation'),
    welcome: $('#welcome-view'),
    messages: $('#messages-list'),
    chatScroll: $('#chat-scroll'),
    composerForm: $('#composer-form'),
    input: $('#message-input'),
    sendButton: $('#send-button'),
    voiceButton: $('#voice-button'),
    listeningBanner: $('#listening-banner'),
    stopListening: $('#stop-listening'),
    liveClock: $('#live-clock'),
    toastRegion: $('#toast-region'),
    sidebar: $('#sidebar'),
    mobileMenu: $('#mobile-menu'),
    sidebarClose: $('#sidebar-close'),
    mobileBackdrop: $('#mobile-backdrop'),
    aboutButton: $('#about-button'),
    aboutDialog: $('#about-dialog'),
  };

  function t(key) {
    return state.locale[key] || state.english[key] || key;
  }

  function safeReadJSON(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function safeWriteJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      showToast(t('toast.storageError') || 'This browser could not save the change.', 'error');
      return false;
    }
  }

  async function loadLocales() {
    await Promise.all(BUILTIN_LANGUAGES.map(async ({ code }) => {
      try {
        const response = await fetch(`/locales/${code}.json`, { cache: 'no-cache' });
        if (!response.ok) throw new Error('Locale not found');
        state.builtins[code] = await response.json();
      } catch (_) {
        state.builtins[code] = {};
      }
    }));
    state.english = state.builtins.en || {};
    try {
      const catalogResponse = await fetch('/language-catalog.json', { cache: 'no-cache' });
      if (!catalogResponse.ok) throw new Error('Language catalog unavailable');
      state.languageCatalog = sanitizeLanguageCatalog(await catalogResponse.json());
    } catch (_) {
      state.languageCatalog = [];
    }
    state.customLocales = sanitizeCustomLocales(safeReadJSON(LOCALE_STORAGE_KEY, []));
    state.sessions = sanitizeSessions(safeReadJSON(SESSION_STORAGE_KEY, []));
    state.commandPackages = sanitizeCommandPackages(safeReadJSON(COMMAND_PACKAGE_STORAGE_KEY, []));
    restorePackageLanguages();
    state.theme = localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
    const savedLanguage = localStorage.getItem('pybot_language_v1') || 'en';
    state.language = getLanguage(savedLanguage) ? savedLanguage : 'en';
    applyTheme();
    populateLanguageSelect();
    applyLocale();
    renderSessions();
    renderConversation();
    populatePackageLanguageSelect();
    renderInstalledPackages();
    updatePackageCount();
    updateClock();
    window.setInterval(updateClock, 15000);
    setupSpeechRecognition();
    void refreshProviderStatus();
    void refreshCortexModels();
    window.setInterval(refreshProviderStatus, 30000);
    window.setInterval(refreshCortexModels, 60000);
  }

  function sanitizeCustomLocales(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 40).filter((item) => {
      if (!item || typeof item !== 'object' || typeof item.code !== 'string' || typeof item.name !== 'string') return false;
      if (!isValidLanguageCode(item.code) || !item.name.trim()) return false;
      return !BUILTIN_LANGUAGES.some((language) => language.code === item.code.toLowerCase());
    }).map((item) => ({
      code: normalizeLanguageCode(item.code),
      name: item.name.slice(0, 48).trim(),
      strings: sanitizeTranslationObject(item.strings, false),
    }));
  }

  function sanitizeLanguageCatalog(value) {
    if (!Array.isArray(value)) return [];
    const catalog = [];
    const seen = new Set();
    value.forEach((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.code !== 'string' || typeof entry.name !== 'string') return;
      if (!isValidLanguageCode(entry.code) || !entry.name.trim()) return;
      const code = normalizeLanguageCode(entry.code);
      if (seen.has(code.toLowerCase())) return;
      seen.add(code.toLowerCase());
      catalog.push({ code, name: entry.name.trim().slice(0, 64) });
    });
    return catalog;
  }

  function sanitizeSessions(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 15).filter((session) => {
      return session && typeof session === 'object' && typeof session.id === 'string' && Array.isArray(session.messages);
    }).map((session) => ({
      id: session.id.slice(0, 80),
      title: typeof session.title === 'string' ? session.title.slice(0, 80) : 'Conversation',
      updatedAt: Number(session.updatedAt) || Date.now(),
      messages: session.messages.slice(-40).filter((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
        .map((message) => ({
          role: message.role,
          content: message.content.slice(0, 4000),
          at: Number(message.at) || Date.now(),
          intent: typeof message.intent === 'string' ? message.intent.slice(0, 40) : '',
        })),
    }));
  }

  function sanitizeCommandPackage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== COMMAND_PACKAGE_FORMAT || Number(value.version) !== 1) {
      throw new TypeError('package-format');
    }
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) throw new TypeError('package-name');
    const rawLanguage = value.language;
    if (!rawLanguage || typeof rawLanguage !== 'object' || typeof rawLanguage.code !== 'string' || typeof rawLanguage.name !== 'string' || !isValidLanguageCode(rawLanguage.code) || !rawLanguage.name.trim()) {
      throw new TypeError('package-language');
    }
    if (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > MAX_COMMANDS_PER_PACKAGE) throw new TypeError('package-commands');
    const commands = value.commands.map((command) => {
      if (!command || typeof command !== 'object' || Array.isArray(command)) throw new TypeError('package-command');
      const name = typeof command.name === 'string' ? command.name.trim() : '';
      const reply = typeof command.reply === 'string' ? command.reply.trim() : '';
      if (!name || name.length > 64) throw new TypeError('package-command-name');
      if (!Array.isArray(command.triggers) || command.triggers.length < 1 || command.triggers.length > 10) throw new TypeError('package-triggers');
      const triggers = command.triggers.map((trigger) => typeof trigger === 'string' ? trigger.trim() : '').filter(Boolean);
      if (triggers.length !== command.triggers.length || triggers.some((trigger) => trigger.length > 120)) throw new TypeError('package-triggers');
      if (!reply || reply.length > 500) throw new TypeError(reply.length > 500 ? 'package-reply-length' : 'package-reply');
      return { name, triggers, reply };
    });
    const id = typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 80 ? value.id : createPackageId();
    const createdAt = typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt))
      ? value.createdAt.slice(0, 40)
      : new Date().toISOString();
    return {
      id,
      format: COMMAND_PACKAGE_FORMAT,
      version: 1,
      name: value.name.trim(),
      language: { code: normalizeLanguageCode(rawLanguage.code), name: rawLanguage.name.trim().slice(0, 48) },
      commands,
      createdAt,
    };
  }

  function sanitizeCommandPackages(value) {
    if (!Array.isArray(value)) return [];
    const packages = [];
    const seen = new Set();
    for (const item of value.slice(0, 30)) {
      try {
        const packageData = sanitizeCommandPackage(item);
        if (seen.has(packageData.id)) continue;
        seen.add(packageData.id);
        packages.push(packageData);
      } catch (_) {
        // Ignore malformed locally stored or imported package records.
      }
    }
    return packages;
  }

  function createPackageId() {
    return (window.crypto && typeof window.crypto.randomUUID === 'function')
      ? window.crypto.randomUUID()
      : `package-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function restorePackageLanguages() {
    let changed = false;
    state.commandPackages.forEach((packageData) => {
      if (!getLanguage(packageData.language.code)) {
        state.customLocales.push({ code: packageData.language.code, name: packageData.language.name, strings: {} });
        changed = true;
      }
    });
    if (changed) safeWriteJSON(LOCALE_STORAGE_KEY, state.customLocales);
  }

  function allLanguages() {
    const unique = new Map();
    [...BUILTIN_LANGUAGES, ...state.customLocales, ...state.languageCatalog].forEach((language) => {
      const key = language.code.toLowerCase();
      if (!unique.has(key)) unique.set(key, language);
    });
    return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
  }

  function getPackageLanguage(code) {
    return allLanguages().find((language) => language.code.toLowerCase() === String(code).toLowerCase()) || null;
  }

  function sanitizeTranslationObject(value, rejectInvalid = true) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const allowedKeys = new Set(Object.keys(state.english));
    const clean = {};
    for (const [key, text] of Object.entries(value)) {
      if (!allowedKeys.has(key)) continue;
      if (typeof text !== 'string') {
        if (rejectInvalid) throw new TypeError('translation-values');
        continue;
      }
      if (text.length > 1000) {
        if (rejectInvalid) throw new RangeError('translation-length');
        continue;
      }
      clean[key] = text;
    }
    return clean;
  }

  function isValidLanguageCode(value) {
    return typeof value === 'string' && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(value.trim());
  }

  function normalizeLanguageCode(value) {
    return value.trim().split('-').map((part, index) => index === 0 ? part.toLowerCase() : part.length === 2 ? part.toUpperCase() : part).join('-');
  }

  function getLanguage(code) {
    const builtin = BUILTIN_LANGUAGES.find((language) => language.code === code);
    if (builtin) return { ...builtin, strings: state.builtins[code] || {} };
    return state.customLocales.find((language) => language.code === code) || null;
  }

  function populateLanguageSelect() {
    const selectedCode = state.language;
    const options = [
      ...BUILTIN_LANGUAGES.map((language) => ({ ...language, builtin: true })),
      ...state.customLocales.map((language) => ({ ...language, builtin: false })),
    ];
    els.languageSelect.replaceChildren();
    options.forEach((language) => {
      const option = document.createElement('option');
      option.value = language.code;
      option.textContent = `${language.code.toUpperCase()} · ${language.name}`;
      els.languageSelect.append(option);
    });
    els.languageSelect.value = options.some((language) => language.code === selectedCode) ? selectedCode : 'en';
    els.languageCodeSuggestions.replaceChildren();
    allLanguages().forEach((language) => {
      const option = document.createElement('option');
      option.value = language.code;
      option.label = language.name;
      els.languageCodeSuggestions.append(option);
    });
  }

  function applyLocale() {
    const selected = getLanguage(state.language) || getLanguage('en');
    state.language = selected.code;
    state.locale = { ...state.english, ...(selected.strings || {}) };
    els.languageSelect.value = state.language;
    document.documentElement.lang = state.language;
    const base = state.language.split('-')[0].toLowerCase();
    document.documentElement.dir = RTL_LANGUAGES.has(base) ? 'rtl' : 'ltr';

    $$('[data-i18n]').forEach((element) => {
      const key = element.dataset.i18n;
      if (t(key)) element.textContent = t(key);
    });
    $$('[data-i18n-placeholder]').forEach((element) => {
      element.placeholder = t(element.dataset.i18nPlaceholder);
    });
    $$('[data-i18n-title]').forEach((element) => {
      element.title = t(element.dataset.i18nTitle);
    });
    $$('[data-i18n-aria]').forEach((element) => {
      element.setAttribute('aria-label', t(element.dataset.i18nAria));
    });
    els.addLanguage.title = t('modal.language.title');
    els.addLanguage.setAttribute('aria-label', t('modal.language.title'));
    els.voiceButton.title = t('composer.voice');
    els.voiceButton.setAttribute('aria-label', t('composer.voice'));
    els.sendButton.title = t('composer.send');
    els.sendButton.setAttribute('aria-label', t('composer.send'));
    els.themeToggle.title = state.theme === 'dark' ? t('theme.light') : t('theme.dark');
    els.themeToggle.setAttribute('aria-label', els.themeToggle.title);
    renderSessions();
    renderConversation();
    populatePackageLanguageSelect();
    renderInstalledPackages();
    updatePackageCount();
    updateClock();
    renderProviderStatus();
  }

  function renderProviderStatus() {
    if (!els.providerTitle || !els.providerBody || !state.cortexStatus) return;
    const status = state.cortexStatus;
    let titleKey = 'status.cortexOfflineTitle';
    let bodyKey = 'status.cortexOfflineBody';
    if (!status.enabled) {
      titleKey = 'status.cortexDisabledTitle';
      bodyKey = 'status.cortexDisabledBody';
    } else if (status.reachable && status.ready) {
      titleKey = 'status.cortexReadyTitle';
      bodyKey = 'status.cortexReadyBody';
    } else if (status.reachable) {
      titleKey = 'status.cortexStartingTitle';
      bodyKey = 'status.cortexStartingBody';
    }
    els.providerTitle.textContent = t(titleKey);
    const model = state.selectedModel || status.model || t('status.cortexAutoModel');
    els.providerBody.textContent = t(bodyKey).replace('{model}', model);
  }

  async function refreshProviderStatus() {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      if (!response.ok) throw new Error('Health check failed');
      const payload = await response.json();
      state.cortexStatus = payload.cortex && typeof payload.cortex === 'object'
        ? payload.cortex
        : { enabled: false, reachable: false, ready: false, model: '' };
    } catch (_) {
      state.cortexStatus = { enabled: true, reachable: false, ready: false, model: '' };
    }
    renderProviderStatus();
  }

  async function refreshCortexModels() {
    try {
      const response = await fetch('/api/models', { cache: 'no-store' });
      if (!response.ok) throw new Error('Model list unavailable');
      const payload = await response.json();
      state.cortexModels = Array.isArray(payload.models)
        ? payload.models.filter((model) => model && typeof model.id === 'string' && model.id.trim()).slice(0, 100)
        : [];
      let saved = '';
      try { saved = localStorage.getItem('pybot_cortex_model_v1') || ''; } catch (_) { /* storage is optional */ }
      const preferred = [state.selectedModel, saved, payload.selected].find((candidate) => state.cortexModels.some((model) => model.id === candidate));
      state.selectedModel = preferred || state.cortexModels[0]?.id || '';
      els.modelSelect.replaceChildren();
      state.cortexModels.forEach((model) => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.id;
        els.modelSelect.append(option);
      });
      if (!state.cortexModels.length) {
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = t(payload.enabled === false ? 'status.modelDisabled' : 'status.modelUnavailable');
        els.modelSelect.append(empty);
      }
      els.modelSelect.value = state.selectedModel;
      els.modelSelect.disabled = payload.enabled === false || !state.cortexModels.length;
    } catch (_) {
      state.cortexModels = [];
      state.selectedModel = '';
      els.modelSelect.replaceChildren();
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = t('status.modelUnavailable');
      els.modelSelect.append(empty);
      els.modelSelect.disabled = true;
    }
    renderProviderStatus();
  }

  function applyTheme() {
    document.body.dataset.theme = state.theme;
    if (els.themeToggle) {
      const title = state.theme === 'dark' ? t('theme.light') : t('theme.dark');
      els.themeToggle.title = title;
      els.themeToggle.setAttribute('aria-label', title);
    }
  }

  function getIntlLocale() {
    try {
      new Intl.DateTimeFormat(state.language);
      return state.language;
    } catch (_) {
      return 'en';
    }
  }

  function updateClock() {
    try {
      els.liveClock.textContent = new Intl.DateTimeFormat(getIntlLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date());
    } catch (_) {
      els.liveClock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  }

  function localContext() {
    const locale = getIntlLocale();
    const now = new Date();
    let time;
    let date;
    try {
      time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(now);
      date = new Intl.DateTimeFormat(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(now);
    } catch (_) {
      time = now.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
      date = now.toLocaleDateString('en', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
    return { time, date };
  }

  function currentSession() {
    return state.sessions.find((session) => session.id === state.activeId) || null;
  }

  function saveSessions() {
    state.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    state.sessions = state.sessions.slice(0, 15);
    safeWriteJSON(SESSION_STORAGE_KEY, state.sessions);
    renderSessions();
  }

  function createSession(firstMessage) {
    const id = (window.crypto && typeof window.crypto.randomUUID === 'function')
      ? window.crypto.randomUUID()
      : `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanTitle = firstMessage.replace(/\s+/g, ' ').trim();
    const session = {
      id,
      title: cleanTitle.length > 35 ? `${cleanTitle.slice(0, 34).trimEnd()}…` : cleanTitle,
      updatedAt: Date.now(),
      messages: [],
    };
    state.sessions.unshift(session);
    state.activeId = id;
    return session;
  }

  function renderSessions() {
    if (!els.sessionList) return;
    const sorted = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    const query = els.sessionSearch.value.trim().toLocaleLowerCase();
    const filtered = query
      ? sorted.filter((session) => `${session.title} ${session.messages.map((message) => message.content).join(' ')}`.toLocaleLowerCase().includes(query))
      : sorted;
    els.sessionCount.textContent = String(Math.min(sorted.length, 99)).padStart(2, '0');
    els.sessionEmpty.hidden = sorted.length > 0 || Boolean(query);
    els.sessionSearchEmpty.hidden = !query || filtered.length > 0;
    els.sessionList.replaceChildren();
    filtered.slice(0, 15).forEach((session) => {
      const item = document.createElement('div');
      item.className = 'session-item';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `session-row${session.id === state.activeId ? ' is-active' : ''}`;
      button.dataset.sessionId = session.id;
      button.title = session.title;
      button.setAttribute('aria-current', session.id === state.activeId ? 'page' : 'false');
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3v-3.2A2.5 2.5 0 0 1 5 14.5v-8Z"/></svg>';
      const title = document.createElement('span');
      title.className = 'session-title';
      title.textContent = session.title || t('sidebar.newChat');
      button.append(title);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'delete-session';
      remove.dataset.deleteSession = session.id;
      remove.setAttribute('aria-label', t('sidebar.delete'));
      remove.title = t('sidebar.delete');
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
      item.append(button, remove);
      els.sessionList.append(item);
    });
  }

  function renderConversation(scrollToEnd = false) {
    const session = currentSession();
    const messages = session ? session.messages : [];
    const hasMessages = messages.length > 0;
    const showTyping = Boolean(state.typingFor && state.typingFor === state.activeId);
    els.welcome.classList.toggle('is-hidden', hasMessages);
    els.exportConversation.disabled = !messages.some((message) => message.role === 'user' || message.role === 'assistant');
    els.messages.classList.toggle('has-messages', hasMessages || showTyping);
    els.messages.replaceChildren();
    messages.forEach((message, index) => els.messages.append(createMessageElement(message, index)));
    if (state.typingFor && state.typingFor === state.activeId) {
      els.messages.append(createTypingElement());
    }
    updateSendButton();
    if (scrollToEnd) requestAnimationFrame(scrollChatToEnd);
  }

  function createMessageElement(message, index) {
    const article = document.createElement('article');
    article.className = `message-row ${message.role === 'user' ? 'user-message' : 'assistant-message'}`;
    const main = document.createElement('div');
    main.className = 'message-main';
    const header = document.createElement('div');
    header.className = 'message-head';
    const name = document.createElement('span');
    name.textContent = message.role === 'user' ? t('message.you') : 'PyBoT';
    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = formatMessageTime(message.at);
    header.append(name, time);
    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = message.content;
    main.append(header, content);

    if (message.role === 'assistant') {
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.innerHTML = '<svg viewBox="0 0 32 32"><path d="M16 3.3 18.5 12l8.2 4-8.2 2.7L16 28.7l-2.8-8.9L5 16l8.2-4L16 3.3Z"/><circle cx="16" cy="16" r="2.4" fill="#15182a"/></svg>';
      article.append(avatar, main);
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      const speak = document.createElement('button');
      speak.type = 'button';
      speak.className = 'message-action';
      speak.dataset.messageAction = 'speak';
      speak.dataset.messageIndex = String(index);
      speak.setAttribute('aria-label', t('message.speak'));
      speak.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4Z"/><path d="M17 9a5 5 0 0 1 0 6m2.5-8.5a8.5 8.5 0 0 1 0 11"/></svg>';
      const speakLabel = document.createElement('span');
      speakLabel.textContent = t('message.speak');
      speak.append(speakLabel);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'message-action';
      copy.dataset.messageAction = 'copy';
      copy.dataset.messageIndex = String(index);
      copy.setAttribute('aria-label', t('message.copy'));
      copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>';
      const copyLabel = document.createElement('span');
      copyLabel.textContent = t('message.copy');
      copy.append(copyLabel);
      actions.append(speak, copy);
      main.append(actions);
    } else {
      article.append(main);
    }
    return article;
  }

  function createTypingElement() {
    const row = document.createElement('article');
    row.className = 'message-row assistant-message';
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = '<svg viewBox="0 0 32 32"><path d="M16 3.3 18.5 12l8.2 4-8.2 2.7L16 28.7l-2.8-8.9L5 16l8.2-4L16 3.3Z"/><circle cx="16" cy="16" r="2.4" fill="#15182a"/></svg>';
    const main = document.createElement('div');
    main.className = 'message-main';
    const header = document.createElement('div');
    header.className = 'message-head';
    const name = document.createElement('span');
    name.textContent = 'PyBoT';
    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = t('message.thinking');
    header.append(name, time);
    const content = document.createElement('div');
    content.className = 'typing-indicator';
    content.setAttribute('aria-label', t('message.thinking'));
    content.innerHTML = '<i></i><i></i><i></i>';
    main.append(header, content);
    row.append(avatar, main);
    return row;
  }

  function formatMessageTime(timestamp) {
    try {
      return new Intl.DateTimeFormat(getIntlLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
    } catch (_) {
      return '';
    }
  }

  function scrollChatToEnd() {
    els.chatScroll.scrollTop = els.chatScroll.scrollHeight;
  }

  function updateSendButton() {
    els.sendButton.disabled = state.pending || !els.input.value.trim();
  }

  function resizeInput() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`;
    updateSendButton();
  }

  async function sendMessage(value) {
    const text = (value || '').trim();
    if (!text || state.pending) return;
    let session = currentSession();
    if (!session) session = createSession(text);
    if (session.messages.length === 0) {
      session.title = text.replace(/\s+/g, ' ').slice(0, 35);
      if (text.length > 35) session.title = `${session.title.slice(0, 34).trimEnd()}…`;
    }
    const targetId = session.id;
    const userMessage = { role: 'user', content: text.slice(0, 2000), at: Date.now() };
    session.messages.push(userMessage);
    if (session.messages.length > 40) session.messages.splice(0, session.messages.length - 40);
    session.updatedAt = Date.now();
    state.pending = true;
    state.typingFor = targetId;
    els.input.value = '';
    resizeInput();
    saveSessions();
    renderConversation(true);
    closeMobileSidebar();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text.slice(0, 2000),
          language: state.language,
          context: localContext(),
          translations: Object.fromEntries(Object.entries(state.locale).filter(([key]) => key.startsWith('response.'))),
          commands: activePackageCommands(),
          model: state.selectedModel,
          history: session.messages.slice(0, -1).slice(-12).map((item) => ({ role: item.role, content: String(item.content || '').slice(0, 1200) })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'The assistant returned an error.');
      appendAssistantReply(targetId, payload.reply, payload.intent || '');
      if (payload.provider_warning) {
        showToast(t(payload.provider_warning), 'error');
        void refreshProviderStatus();
      }
    } catch (error) {
      appendAssistantReply(targetId, t('toast.assistantError'), 'error');
    } finally {
      state.pending = false;
      if (state.typingFor === targetId) state.typingFor = null;
      updateSendButton();
      if (state.activeId === targetId) renderConversation(true);
    }
  }

  function downloadCurrentConversation() {
    const session = currentSession();
    if (!session || !session.messages.length) return;
    const lines = [`# ${session.title || t('sidebar.newChat')}`, '', `_${new Date().toLocaleString(getIntlLocale())}_`, ''];
    session.messages.forEach((message) => {
      const speaker = message.role === 'user' ? t('message.you') : 'PyBoT';
      const timestamp = formatMessageTime(message.at);
      lines.push(`## ${speaker}${timestamp ? ` · ${timestamp}` : ''}`, '', message.content, '');
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const slug = (session.title || 'conversation').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    link.href = url;
    link.download = `pybot-${slug || 'conversation'}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(t('chat.exported'));
  }

  function appendAssistantReply(sessionId, reply, intent) {
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    session.messages.push({ role: 'assistant', content: String(reply || t('response.unknown')).slice(0, 4000), at: Date.now(), intent });
    if (session.messages.length > 40) session.messages.splice(0, session.messages.length - 40);
    session.updatedAt = Date.now();
    saveSessions();
    if (state.activeId === sessionId) renderConversation(true);
  }

  function startNewConversation() {
    state.activeId = null;
    state.typingFor = null;
    renderSessions();
    renderConversation();
    els.input.value = '';
    resizeInput();
    els.input.focus();
    closeMobileSidebar();
  }

  function showToast(message, type = 'success') {
    if (!els.toastRegion) return;
    const toast = document.createElement('div');
    toast.className = `toast${type === 'error' ? ' error' : ''}`;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', type === 'error' ? 'M12 3 22 21H2L12 3Zm0 6v5m0 3h.01' : 'm5 12 4 4L19 6');
    icon.append(path);
    const text = document.createElement('span');
    text.textContent = message;
    toast.append(icon, text);
    els.toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), 3600);
  }

  function openDialog(dialog) {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function openLanguageDialog() {
    els.languageError.textContent = '';
    els.languageForm.reset();
    openDialog(els.languageDialog);
    window.setTimeout(() => els.languageName.focus(), 20);
  }

  function languageError(key) {
    els.languageError.textContent = t(key);
  }

  function addCustomLanguage(event) {
    event.preventDefault();
    const name = els.languageName.value.trim();
    const rawCode = els.languageCode.value.trim();
    if (!name || !isValidLanguageCode(rawCode)) {
      languageError('modal.language.errorName');
      return;
    }
    const code = normalizeLanguageCode(rawCode);
    const isBuiltinCode = BUILTIN_LANGUAGES.some((language) => language.code.toLowerCase() === code.toLowerCase());
    const existingIndex = state.customLocales.findIndex((language) => language.code.toLowerCase() === code.toLowerCase());
    if (isBuiltinCode) {
      languageError('modal.language.errorDuplicate');
      return;
    }

    let rawTranslations = {};
    const source = els.languageJson.value.trim();
    if (source) {
      try {
        rawTranslations = JSON.parse(source);
      } catch (_) {
        languageError('modal.language.errorJson');
        return;
      }
      if (!rawTranslations || typeof rawTranslations !== 'object' || Array.isArray(rawTranslations)) {
        languageError('modal.language.errorObject');
        return;
      }
    }

    let strings;
    try {
      strings = sanitizeTranslationObject(rawTranslations);
    } catch (error) {
      languageError(error instanceof RangeError ? 'modal.language.errorTooLong' : 'modal.language.errorObject');
      return;
    }
    const previousLocales = [...state.customLocales];
    const updatedLocale = {
      code,
      name: name.slice(0, 48),
      strings: { ...(existingIndex >= 0 ? state.customLocales[existingIndex].strings : {}), ...strings },
    };
    if (existingIndex >= 0) state.customLocales[existingIndex] = updatedLocale;
    else state.customLocales.unshift(updatedLocale);
    if (!safeWriteJSON(LOCALE_STORAGE_KEY, state.customLocales)) {
      state.customLocales = previousLocales;
      return;
    }
    state.language = code;
    localStorage.setItem('pybot_language_v1', code);
    populateLanguageSelect();
    applyLocale();
    closeDialog(els.languageDialog);
    showToast(t('modal.language.saved'));
  }

  function populatePackageLanguageSelect() {
    if (!els.packageLanguageSelect) return;
    const current = els.packageLanguageSelect.value || state.language || 'en';
    const query = els.packageLanguageSearch.value.trim().toLocaleLowerCase();
    const languages = allLanguages();
    const visible = query
      ? languages.filter((language) => `${language.code} ${language.name}`.toLocaleLowerCase().includes(query))
      : languages;
    els.packageLanguageSelect.replaceChildren();
    if (!visible.length) {
      const emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.disabled = true;
      emptyOption.textContent = t('package.noLanguageMatches');
      els.packageLanguageSelect.append(emptyOption);
      return;
    }
    visible.forEach((language) => {
      const option = document.createElement('option');
      option.value = language.code;
      option.textContent = `${language.code.toUpperCase()} · ${language.name}`;
      els.packageLanguageSelect.append(option);
    });
    const fallback = visible.some((language) => language.code === state.language) ? state.language : visible[0].code;
    els.packageLanguageSelect.value = visible.some((language) => language.code === current) ? current : fallback;
  }

  function openPackageDialog() {
    els.packageError.textContent = '';
    els.packageForm.reset();
    populatePackageLanguageSelect();
    els.packageLanguageSelect.value = allLanguages().some((language) => language.code === state.language) ? state.language : 'en';
    els.commandEditorList.replaceChildren();
    addPackageCommandEditor();
    renderInstalledPackages();
    openDialog(els.packageDialog);
    window.setTimeout(() => els.packageName.focus(), 20);
  }

  function setPackageError(key) {
    els.packageError.textContent = t(key);
  }

  function addPackageCommandEditor() {
    const index = $$('.command-editor', els.commandEditorList).length;
    if (index >= MAX_COMMANDS_PER_PACKAGE) {
      setPackageError('package.errorLimit');
      return;
    }
    els.packageError.textContent = '';
    const card = document.createElement('section');
    card.className = 'command-editor';
    card.dataset.commandEditor = 'true';

    const heading = document.createElement('div');
    heading.className = 'command-editor-heading';
    const indexBadge = document.createElement('span');
    indexBadge.className = 'command-index-badge';
    const title = document.createElement('strong');
    title.className = 'command-editor-title';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-command-button';
    remove.dataset.removeCommand = 'true';
    remove.title = t('package.removeCommand');
    remove.setAttribute('aria-label', t('package.removeCommand'));
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';
    heading.append(indexBadge, title, remove);

    const nameField = createPackageField('name', 'input', 'package.commandName', 'package.commandNamePlaceholder', 64);
    const triggerField = createPackageField('triggers', 'textarea', 'package.triggersLabel', 'package.triggersPlaceholder', 1200);
    triggerField.control.rows = 2;
    const triggerHelp = document.createElement('small');
    triggerHelp.className = 'command-field-hint';
    triggerHelp.textContent = t('package.triggersHelp');
    const replyField = createPackageField('reply', 'textarea', 'package.replyLabel', 'package.replyPlaceholder', 500);
    replyField.control.rows = 3;
    card.append(heading, nameField.label, triggerField.label, triggerHelp, replyField.label);
    els.commandEditorList.append(card);
    renumberCommandEditors();
  }

  function createPackageField(fieldName, controlTag, labelKey, placeholderKey, maxLength) {
    const label = document.createElement('label');
    label.className = `field-label package-command-field package-${fieldName}-field`;
    const caption = document.createElement('span');
    caption.textContent = t(labelKey);
    const control = document.createElement(controlTag);
    control.dataset.commandField = fieldName;
    control.maxLength = maxLength;
    control.placeholder = t(placeholderKey);
    if (controlTag === 'input') {
      control.type = 'text';
      control.autocomplete = 'off';
    } else {
      control.spellcheck = false;
    }
    label.append(caption, control);
    return { label, control };
  }

  function renumberCommandEditors() {
    $$('.command-editor', els.commandEditorList).forEach((card, index) => {
      $('.command-index-badge', card).textContent = String(index + 1).padStart(2, '0');
      $('.command-editor-title', card).textContent = `${t('package.commandLabel')} ${index + 1}`;
    });
  }

  function normalizeCommandPhrase(value) {
    return value.normalize('NFKC').toLowerCase()
      .replace(/['’‘ʼ]/g, '')
      .replace(COMMAND_MARKS, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function validateAndBuildPackage() {
    const name = els.packageName.value.trim();
    if (!name || name.length > 80) throw new Error('package.errorName');
    const language = getPackageLanguage(els.packageLanguageSelect.value);
    if (!language) throw new Error('package.errorLanguage');
    const cards = $$('.command-editor', els.commandEditorList);
    if (!cards.length || cards.length > MAX_COMMANDS_PER_PACKAGE) throw new Error('package.errorCommands');
    const seenPhrases = new Set();
    const commands = cards.map((card) => {
      const commandName = $('[data-command-field="name"]', card).value.trim();
      const triggerText = $('[data-command-field="triggers"]', card).value;
      const reply = $('[data-command-field="reply"]', card).value.trim();
      const triggers = triggerText.split(/\r?\n/).map((phrase) => phrase.trim()).filter(Boolean);
      if (!commandName || commandName.length > 64) throw new Error('package.errorCommandName');
      if (!triggers.length || triggers.length > 10 || triggers.some((phrase) => phrase.length > 120)) throw new Error('package.errorTriggers');
      for (const phrase of triggers) {
        const normalized = normalizeCommandPhrase(phrase);
        if (seenPhrases.has(normalized)) throw new Error('package.errorDuplicateTrigger');
        seenPhrases.add(normalized);
      }
      if (!reply || reply.length > 500) throw new Error(reply.length > 500 ? 'package.errorReplyTooLong' : 'package.errorReply');
      return { name: commandName, triggers, reply };
    });
    return sanitizeCommandPackage({
      id: createPackageId(),
      format: COMMAND_PACKAGE_FORMAT,
      version: 1,
      name,
      language: { code: language.code, name: language.name },
      commands,
      createdAt: new Date().toISOString(),
    });
  }

  function packageLanguageExists(packageData) {
    return Boolean(getLanguage(packageData.language.code));
  }

  function ensurePackageLanguage(packageData) {
    if (packageLanguageExists(packageData)) return;
    state.customLocales.unshift({ code: packageData.language.code, name: packageData.language.name, strings: {} });
    safeWriteJSON(LOCALE_STORAGE_KEY, state.customLocales);
    populateLanguageSelect();
    populatePackageLanguageSelect();
  }

  function installCommandPackage(packageData) {
    const previous = [...state.commandPackages];
    ensurePackageLanguage(packageData);
    const matchingIndex = state.commandPackages.findIndex((item) =>
      item.id === packageData.id || (item.name.toLocaleLowerCase() === packageData.name.toLocaleLowerCase() && item.language.code.toLowerCase() === packageData.language.code.toLowerCase())
    );
    if (matchingIndex >= 0) {
      packageData.id = state.commandPackages[matchingIndex].id;
      state.commandPackages[matchingIndex] = packageData;
    } else {
      state.commandPackages.unshift(packageData);
    }
    state.commandPackages = state.commandPackages.slice(0, 30);
    if (!safeWriteJSON(COMMAND_PACKAGE_STORAGE_KEY, state.commandPackages)) {
      state.commandPackages = previous;
      renderInstalledPackages();
      updatePackageCount();
      return false;
    }
    renderInstalledPackages();
    updatePackageCount();
    return true;
  }

  function createPackageDownload(packageData) {
    const safeName = packageData.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pybot-commands';
    const blob = new Blob([JSON.stringify(packageData, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName}.pybot.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function buildAndInstallPackage(event) {
    event.preventDefault();
    els.packageError.textContent = '';
    let packageData;
    try {
      packageData = validateAndBuildPackage();
    } catch (error) {
      setPackageError(error.message.startsWith('package.') ? error.message : 'package.errorInvalid');
      return;
    }
    if (installCommandPackage(packageData)) {
      showToast(t('package.installedToast'));
      closeDialog(els.packageDialog);
    }
  }

  function downloadPackageFromBuilder() {
    els.packageError.textContent = '';
    try {
      createPackageDownload(validateAndBuildPackage());
      showToast(t('package.downloadToast'));
    } catch (error) {
      setPackageError(error.message.startsWith('package.') ? error.message : 'package.errorInvalid');
    }
  }

  async function importCommandPackage(file) {
    if (!file) return;
    els.packageFile.value = '';
    if (file.size > 128 * 1024) {
      setPackageError('package.errorFileTooLarge');
      els.packageFile.value = '';
      return;
    }
    let raw;
    try {
      raw = JSON.parse(await file.text());
    } catch (_) {
      setPackageError('package.errorJson');
      return;
    }
    let packageData;
    try {
      packageData = sanitizeCommandPackage(raw);
    } catch (error) {
      const errors = {
        'package-format': 'package.errorFormat',
        'package-name': 'package.errorName',
        'package-language': 'package.errorLanguage',
        'package-commands': 'package.errorCommands',
        'package-command-name': 'package.errorCommandName',
        'package-triggers': 'package.errorTriggers',
        'package-reply': 'package.errorReply',
        'package-reply-length': 'package.errorReplyTooLong',
      };
      setPackageError(errors[error.message] || 'package.errorInvalid');
      return;
    }
    if (installCommandPackage(packageData)) {
      els.packageError.textContent = '';
      showToast(t('package.importedToast'));
    }
    els.packageFile.value = '';
  }

  function updatePackageCount() {
    if (els.packageCount) els.packageCount.textContent = String(Math.min(state.commandPackages.length, 99)).padStart(2, '0');
  }

  function renderInstalledPackages() {
    if (!els.installedPackageList) return;
    const packages = state.commandPackages;
    els.installedPackageCount.textContent = String(Math.min(packages.length, 99)).padStart(2, '0');
    els.installedPackagesEmpty.hidden = packages.length > 0;
    els.installedPackageList.replaceChildren();
    packages.forEach((packageData) => {
      const row = document.createElement('div');
      row.className = 'installed-package-row';
      const icon = document.createElement('span');
      icon.className = 'installed-package-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="m4 7 8-4 8 4-8 4-8-4Z"/><path d="M4 7v10l8 4 8-4V7M12 11v10"/></svg>';
      const details = document.createElement('span');
      details.className = 'installed-package-details';
      const title = document.createElement('strong');
      title.textContent = packageData.name;
      const meta = document.createElement('small');
      const commandCount = packageData.commands.length;
      meta.textContent = `${packageData.language.name} · ${commandCount} ${t(commandCount === 1 ? 'package.commandCount' : 'package.commandsCount')}`;
      details.append(title, meta);
      const actions = document.createElement('span');
      actions.className = 'installed-package-actions';
      const exportButton = document.createElement('button');
      exportButton.type = 'button';
      exportButton.className = 'package-row-action';
      exportButton.dataset.exportPackage = packageData.id;
      exportButton.title = t('package.export');
      exportButton.setAttribute('aria-label', `${t('package.export')}: ${packageData.name}`);
      exportButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 20h14"/></svg>';
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'package-row-action package-row-remove';
      removeButton.dataset.removePackage = packageData.id;
      removeButton.title = t('package.remove');
      removeButton.setAttribute('aria-label', `${t('package.remove')}: ${packageData.name}`);
      removeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
      actions.append(exportButton, removeButton);
      row.append(icon, details, actions);
      els.installedPackageList.append(row);
    });
  }

  function activePackageCommands() {
    const selectedCode = state.language.toLowerCase();
    const selectedBase = selectedCode.split('-', 1)[0];
    return state.commandPackages
      .filter((packageData) => {
        const packageCode = packageData.language.code.toLowerCase();
        return packageCode === selectedCode || packageCode.split('-', 1)[0] === selectedBase;
      })
      .flatMap((packageData) => packageData.commands.map((command) => ({ ...command, language: packageData.language.code })))
      .slice(0, MAX_RUNTIME_COMMANDS);
  }

  function downloadLanguageTemplate() {
    const template = Object.fromEntries(Object.keys(state.english).sort().map((key) => [key, '']));
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pybot-language-template.json';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(t('modal.language.templateSaved'));
  }

  function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_STORAGE_KEY, state.theme); } catch (_) { /* storage is optional */ }
    applyTheme();
  }

  function setupSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      state.recognitionActive = true;
      els.listeningBanner.classList.add('is-visible');
      els.voiceButton.classList.add('is-listening');
      els.voiceButton.setAttribute('aria-pressed', 'true');
    };
    recognition.onresult = (event) => {
      const transcript = event.results && event.results[0] && event.results[0][0] ? event.results[0][0].transcript : '';
      if (transcript) {
        const current = els.input.value.trim();
        els.input.value = current ? `${current} ${transcript.trim()}` : transcript.trim();
        resizeInput();
        els.input.focus();
      } else {
        showToast(t('voice.noTranscript'), 'error');
      }
    };
    recognition.onerror = (event) => {
      if (event.error !== 'aborted' && event.error !== 'no-speech') {
        showToast(event.error === 'not-allowed' ? t('voice.unsupported') : t('voice.noTranscript'), 'error');
      }
    };
    recognition.onend = () => {
      state.recognitionActive = false;
      els.listeningBanner.classList.remove('is-visible');
      els.voiceButton.classList.remove('is-listening');
      els.voiceButton.setAttribute('aria-pressed', 'false');
    };
    state.recognition = recognition;
  }

  function toggleVoiceInput() {
    if (!state.recognition) {
      showToast(t('voice.unsupported'), 'error');
      return;
    }
    if (state.recognitionActive) {
      state.recognition.stop();
      return;
    }
    state.recognition.lang = state.language || 'en';
    try {
      state.recognition.start();
    } catch (_) {
      showToast(t('voice.noTranscript'), 'error');
    }
  }

  function closeMobileSidebar() {
    els.sidebar.classList.remove('is-open');
    els.mobileBackdrop.classList.remove('is-visible');
  }

  function toggleMobileSidebar(open) {
    const shouldOpen = typeof open === 'boolean' ? open : !els.sidebar.classList.contains('is-open');
    els.sidebar.classList.toggle('is-open', shouldOpen);
    els.mobileBackdrop.classList.toggle('is-visible', shouldOpen);
  }

  async function handleMessageAction(event) {
    const button = event.target.closest('[data-message-action]');
    if (!button) return;
    const session = currentSession();
    const message = session && session.messages[Number(button.dataset.messageIndex)];
    if (!message) return;
    if (button.dataset.messageAction === 'speak') {
      if (!('speechSynthesis' in window)) {
        showToast(t('voice.unsupported'), 'error');
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(message.content);
      utterance.lang = state.language || 'en';
      window.speechSynthesis.speak(utterance);
    } else if (button.dataset.messageAction === 'copy') {
      try {
        await navigator.clipboard.writeText(message.content);
        showToast(t('message.copied'));
      } catch (_) {
        showToast(t('message.copyError'), 'error');
      }
    }
  }

  function setCortexModel() {
    state.selectedModel = els.modelSelect.value || '';
    try {
      if (state.selectedModel) localStorage.setItem('pybot_cortex_model_v1', state.selectedModel);
      else localStorage.removeItem('pybot_cortex_model_v1');
    } catch (_) { /* storage is optional */ }
    renderProviderStatus();
    showToast(t('toast.modelSelected'));
  }

  function bindEvents() {
    els.modelSelect.addEventListener('change', setCortexModel);
    els.sessionSearch.addEventListener('input', () => {
      window.clearTimeout(sessionSearchTimer);
      sessionSearchTimer = window.setTimeout(renderSessions, 100);
    });
    els.exportConversation.addEventListener('click', downloadCurrentConversation);
    els.languageSelect.addEventListener('change', () => {
      state.language = els.languageSelect.value || 'en';
      try { localStorage.setItem('pybot_language_v1', state.language); } catch (_) { /* storage is optional */ }
      if (state.recognitionActive) state.recognition.stop();
      applyLocale();
    });
    els.addLanguage.addEventListener('click', openLanguageDialog);
    els.languageCode.addEventListener('change', () => {
      const selected = allLanguages().find((language) => language.code.toLowerCase() === els.languageCode.value.trim().toLowerCase());
      if (selected && !els.languageName.value.trim()) els.languageName.value = selected.name;
    });
    els.languageForm.addEventListener('submit', addCustomLanguage);
    els.templateButton.addEventListener('click', downloadLanguageTemplate);
    els.packageBuilderButton.addEventListener('click', openPackageDialog);
    els.packageForm.addEventListener('submit', buildAndInstallPackage);
    els.addPackageCommand.addEventListener('click', addPackageCommandEditor);
    els.packageLanguageSearch.addEventListener('input', populatePackageLanguageSelect);
    els.downloadCommandPackage.addEventListener('click', downloadPackageFromBuilder);
    els.packageFile.addEventListener('change', async () => {
      const file = els.packageFile.files && els.packageFile.files[0];
      await importCommandPackage(file);
    });
    els.languageFile.addEventListener('change', async () => {
      const file = els.languageFile.files && els.languageFile.files[0];
      if (!file) return;
      if (file.size > 64 * 1024) {
        languageError('modal.language.errorTooLong');
        els.languageFile.value = '';
        return;
      }
      try {
        els.languageJson.value = await file.text();
        els.languageError.textContent = '';
      } catch (_) {
        languageError('modal.language.errorJson');
      }
    });
    $$('[data-close-dialog]').forEach((button) => {
      button.addEventListener('click', () => {
        const dialog = document.getElementById(button.dataset.closeDialog);
        if (dialog) closeDialog(dialog);
      });
    });
    [els.languageDialog, els.packageDialog, els.aboutDialog].forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) closeDialog(dialog);
      });
    });
    els.themeToggle.addEventListener('click', toggleTheme);
    els.newChat.addEventListener('click', startNewConversation);
    els.installedPackageList.addEventListener('click', (event) => {
      const exportButton = event.target.closest('[data-export-package]');
      if (exportButton) {
        const packageData = state.commandPackages.find((item) => item.id === exportButton.dataset.exportPackage);
        if (packageData) {
          createPackageDownload(packageData);
          showToast(t('package.downloadToast'));
        }
        return;
      }
      const removeButton = event.target.closest('[data-remove-package]');
      if (!removeButton) return;
      const previous = [...state.commandPackages];
      state.commandPackages = state.commandPackages.filter((item) => item.id !== removeButton.dataset.removePackage);
      if (!safeWriteJSON(COMMAND_PACKAGE_STORAGE_KEY, state.commandPackages)) state.commandPackages = previous;
      renderInstalledPackages();
      updatePackageCount();
      if (state.commandPackages.length !== previous.length) showToast(t('package.removedToast'));
    });
    els.sessionList.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-delete-session]');
      if (remove) {
        const id = remove.dataset.deleteSession;
        state.sessions = state.sessions.filter((session) => session.id !== id);
        if (state.activeId === id) state.activeId = null;
        saveSessions();
        renderConversation();
        showToast(t('toast.deleted'));
        return;
      }
      const open = event.target.closest('[data-session-id]');
      if (!open) return;
      state.activeId = open.dataset.sessionId;
      state.typingFor = null;
      renderSessions();
      renderConversation(true);
      closeMobileSidebar();
    });
    els.composerForm.addEventListener('submit', (event) => {
      event.preventDefault();
      sendMessage(els.input.value);
    });
    els.input.addEventListener('input', resizeInput);
    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        els.composerForm.requestSubmit();
      }
    });
    els.voiceButton.addEventListener('click', toggleVoiceInput);
    els.stopListening.addEventListener('click', () => {
      if (state.recognitionActive && state.recognition) state.recognition.stop();
    });
    els.messages.addEventListener('click', handleMessageAction);
    $$('.prompt-card').forEach((button) => {
      button.addEventListener('click', () => sendMessage(t(button.dataset.promptKey)));
    });
    els.aboutButton.addEventListener('click', () => openDialog(els.aboutDialog));
    els.mobileMenu.addEventListener('click', () => toggleMobileSidebar(true));
    els.sidebarClose.addEventListener('click', closeMobileSidebar);
    els.mobileBackdrop.addEventListener('click', closeMobileSidebar);
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        startNewConversation();
      }
      if (event.key === 'Escape') closeMobileSidebar();
    });
  }

  bindEvents();
  loadLocales();
})();
