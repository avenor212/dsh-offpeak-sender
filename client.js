/**
 * `dsh-offpeak-sender` — peak-hour send guard.
 *
 * The composer's ordinary submission path calls
 * `conversation.sendSession(...)`; this plugin wraps that prototype method so a
 * submission whose model sits inside a configured peak-pricing window asks the
 * user first: send now, queue until off-peak, or discard. Queues are local
 * (browser memory + localStorage), scoped per session, and released by a local
 * one-second clock. No Agent API and no model call is involved.
 */
window.__ModuleLoader__.load({
  id: 'dsh-offpeak-sender',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    const PLUGIN_ID = 'dsh-offpeak-sender';
    const NS = 'offpeak-sender';
    const CONFIG_KEY = 'dsh.offpeak-sender.config.v1';
    const QUEUE_KEY = 'dsh.offpeak-sender.queue.v1';
    const MINUTE = 60000;
    const DAY = 86400000;
    const SEND_COOLDOWN = 4000;
    const MAX_ATTEMPTS = 3;

    /* ------------------------------------------------------------------ *
     * Pure helpers (exposed as `__pure` for offline checks)              *
     * ------------------------------------------------------------------ */

    function uid(prefix) {
      return (
        String(prefix || 'id') +
        '-' +
        Date.now().toString(36) +
        '-' +
        Math.random().toString(36).slice(2, 7)
      );
    }

    function parseClock(value) {
      const raw = typeof value === 'string' ? value.trim() : '';
      const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
      if (!match) return null;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
      if (hour > 24 || minute > 59) return null;
      const total = hour * 60 + minute;
      if (total > 1440) return null;
      return total;
    }

    function formatClock(minutes) {
      const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
      const hour = Math.floor(total / 60);
      const minute = total % 60;
      return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
    }

    function localMinute(now) {
      const date = new Date(now);
      return date.getHours() * 60 + date.getMinutes();
    }

    function isInWindowAt(minute, window) {
      const start = parseClock(window && window.start);
      const end = parseClock(window && window.end);
      if (start === null || end === null) return false;
      if (start === end) return false;
      if (end > start) return minute >= start && minute < end;
      return minute >= start || minute < end;
    }

    /* ------------------------------------------------------------------ *
     * Calendar (mainland China public holidays + make-up workdays)       *
     * ------------------------------------------------------------------ */

    const CALENDAR_TYPES = ['everyday', 'legalWorkday', 'legalHoliday', 'weekend', 'weekday'];

    const REGIONS = {
      cn: { id: 'cn', labelKey: 'region.cn' },
    };

    // Government-announced arrangements, kept as [name, first day, days].
    // Sources (release dates): 2024 → 2023-10-25, 2025 → 2024-11-12,
    // 2026 → 2025-11-04, 2027 → 2026-11-05.
    const CN_HOLIDAYS = {
      2024: [
        ['元旦', '2024-01-01', 1],
        ['春节', '2024-02-10', 8],
        ['清明节', '2024-04-04', 3],
        ['劳动节', '2024-05-01', 5],
        ['端午节', '2024-06-10', 1],
        ['中秋节', '2024-09-15', 3],
        ['国庆节', '2024-10-01', 7],
      ],
      2025: [
        ['元旦', '2025-01-01', 1],
        ['春节', '2025-01-28', 8],
        ['清明节', '2025-04-04', 3],
        ['劳动节', '2025-05-01', 5],
        ['端午节', '2025-05-31', 3],
        ['国庆节、中秋节', '2025-10-01', 8],
      ],
      2026: [
        ['元旦', '2026-01-01', 3],
        ['春节', '2026-02-15', 9],
        ['清明节', '2026-04-04', 3],
        ['劳动节', '2026-05-01', 5],
        ['端午节', '2026-06-19', 3],
        ['中秋节', '2026-09-25', 3],
        ['国庆节', '2026-10-01', 7],
      ],
      2027: [
        ['元旦', '2027-01-01', 3],
        ['春节', '2027-02-05', 9],
        ['清明节', '2027-04-03', 3],
        ['劳动节', '2027-05-01', 5],
        ['端午节', '2027-06-09', 1],
        ['中秋节', '2027-09-15', 1],
        ['国庆节', '2027-10-01', 7],
      ],
    };

    const CN_MAKEUPS = {
      2024: [
        '2024-02-04',
        '2024-02-18',
        '2024-04-07',
        '2024-04-28',
        '2024-05-11',
        '2024-09-14',
        '2024-09-29',
        '2024-10-12',
      ],
      2025: ['2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11'],
      2026: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'],
      2027: ['2027-01-31', '2027-02-14', '2027-05-08', '2027-09-26', '2027-10-09'],
    };

    const CN_RELEASED = {
      2024: '2023-10-25',
      2025: '2024-11-12',
      2026: '2025-11-04',
      2027: '2026-11-05',
    };

    const CALENDARS = { cn: { holidays: CN_HOLIDAYS, makeups: CN_MAKEUPS, released: CN_RELEASED } };

    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    function dateKeyOf(ms) {
      const date = new Date(ms);
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function dateSpan(startKey, count) {
      const parts = String(startKey).split('-').map(Number);
      const keys = [];
      for (let index = 0; index < count; index += 1) {
        keys.push(dateKeyOf(new Date(parts[0], (parts[1] || 1) - 1, (parts[2] || 1) + index).getTime()));
      }
      return keys;
    }

    function weekdayOfKey(dateKey) {
      const parts = String(dateKey).split('-').map(Number);
      if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return -1;
      return new Date(parts[0], parts[1] - 1, parts[2]).getDay();
    }

    function parseDateLines(text) {
      const result = {};
      const lines = String(text || '').split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (line === '') continue;
        const match = /^(\d{4}-\d{2}-\d{2})\s*(.*)$/.exec(line);
        if (!match) continue;
        const label = match[2] && match[2].trim() !== '' ? match[2].trim() : 'holiday';
        result[match[1]] = label;
      }
      return result;
    }

    function formatDateLines(map, omitLabel) {
      return Object.keys(map || {})
        .sort()
        .map(function (key) {
          const label = map[key];
          return omitLabel || !label || label === 'holiday' ? key : key + ' ' + label;
        })
        .join('\n');
    }

    /**
     * Merge built-in annual data with user overrides into a lookup index.
     * `region` selects the data set; only `cn` ships today and the shape is
     * already per-region so another country only needs a new CALENDARS entry.
     */
    function buildCalendarIndex(overrides, region) {
      const regionId = REGIONS[region] ? region : 'cn';
      const years = {};
      const table = CALENDARS[regionId];
      for (const year of Object.keys(table.holidays)) {
        const holidays = {};
        for (const span of table.holidays[year]) {
          for (const key of dateSpan(span[1], span[2])) holidays[key] = span[0];
        }
        const makeups = {};
        for (const key of table.makeups[year]) makeups[key] = '调休上班';
        years[year] = {
          status: 'official',
          note: table.released[year] || '',
          holidays: holidays,
          makeups: makeups,
        };
      }
      const custom = overrides && typeof overrides === 'object' ? overrides : {};
      for (const year of Object.keys(custom)) {
        if (!/^\d{4}$/.test(year)) continue;
        const entry = custom[year] || {};
        const base = years[year] || { status: 'custom', note: '', holidays: {}, makeups: {} };
        years[year] = {
          status: 'custom',
          note: typeof entry.note === 'string' ? entry.note : '',
          holidays: Object.assign({}, base.holidays, parseDateLines(entry.holidaysText)),
          makeups: Object.assign({}, base.makeups, parseDateLines(entry.makeupsText)),
        };
      }
      return { years: years };
    }

    function calendarYear(index, dateKey) {
      if (!index || !index.years) return undefined;
      return index.years[String(dateKey).slice(0, 4)];
    }

    const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

    /** Human-facing classification of one local date. */
    function describeDate(index, dateKey) {
      const weekday = weekdayOfKey(dateKey);
      const entry = calendarYear(index, dateKey);
      let kind = 'plain';
      if (entry && entry.holidays[dateKey]) kind = 'holiday';
      else if (entry && entry.makeups[dateKey]) kind = 'makeup';
      else if (weekday === 0 || weekday === 6) kind = 'weekend';
      return { weekdayKey: WEEKDAY_KEYS[weekday] || 'mon', kind: kind };
    }

    /** Classify one local date against a calendar rule type. */
    function matchesCalendar(index, type, dateKey) {
      const weekday = weekdayOfKey(dateKey);
      if (weekday < 0) return false;
      const entry = calendarYear(index, dateKey);
      switch (type) {
        case 'everyday':
          return true;
        case 'weekend':
          return weekday === 0 || weekday === 6;
        case 'weekday':
          return weekday >= 1 && weekday <= 5;
        case 'legalHoliday':
          if (entry && entry.holidays[dateKey]) return true;
          if (entry && entry.makeups[dateKey]) return false;
          return weekday === 0 || weekday === 6;
        case 'legalWorkday':
        default:
          if (entry && entry.makeups[dateKey]) return true;
          if (entry && entry.holidays[dateKey]) return false;
          return weekday >= 1 && weekday <= 5;
      }
    }

    /**
     * The peak window covering `now`, with the instant it ends and the local
     * date the occurrence belongs to (a cross-midnight window is owned by the
     * day it started).
     */
    function peakWindow(now, windows, calendarType, index) {
      const minute = localMinute(now);
      const today = dateKeyOf(now);
      const yesterday = dateKeyOf(now - DAY);
      const list = Array.isArray(windows) ? windows : [];
      for (const window of list) {
        if (!window) continue;
        const start = parseClock(window.start);
        const end = parseClock(window.end);
        if (start === null || end === null || start === end) continue;
        let anchor = null;
        if (end > start) {
          if (minute >= start && minute < end) anchor = today;
        } else if (minute >= start) {
          anchor = today;
        } else if (minute < end) {
          anchor = yesterday;
        }
        if (anchor === null) continue;
        if (!matchesCalendar(index, calendarType, anchor)) continue;
        const date = new Date(now);
        const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        let endsAt = midnight + end * MINUTE;
        if (endsAt <= now) endsAt += DAY;
        return { window: window, anchorDate: anchor, endsAt: endsAt };
      }
      return null;
    }

    function durationParts(ms) {
      const total = Math.max(0, Math.round(ms / 1000));
      return {
        hours: Math.floor(total / 3600),
        minutes: Math.floor((total % 3600) / 60),
        seconds: total % 60,
      };
    }

    function normalizeWindows(list) {
      if (!Array.isArray(list)) return [];
      const windows = [];
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        windows.push({
          start: typeof entry.start === 'string' ? entry.start : '08:00',
          end: typeof entry.end === 'string' ? entry.end : '12:00',
        });
      }
      return windows.slice(0, 8);
    }

    function normalizeCalendar(value) {
      return CALENDAR_TYPES.indexOf(value) === -1 ? 'everyday' : value;
    }

    function normalizeRegion(value) {
      return typeof value === 'string' && REGIONS[value] ? value : 'cn';
    }

    function normalizeCalendarOverrides(raw) {
      const result = {};
      if (!raw || typeof raw !== 'object') return result;
      for (const year of Object.keys(raw)) {
        if (!/^\d{4}$/.test(year)) continue;
        const entry = raw[year];
        if (!entry || typeof entry !== 'object') continue;
        result[year] = {
          note: typeof entry.note === 'string' ? entry.note : '',
          holidaysText: typeof entry.holidaysText === 'string' ? entry.holidaysText : '',
          makeupsText: typeof entry.makeupsText === 'string' ? entry.makeupsText : '',
        };
      }
      return result;
    }

    function normalizeGroups(list) {
      if (!Array.isArray(list)) return [];
      const seen = {};
      const groups = [];
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        let id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : uid('group');
        if (seen[id]) id = uid('group');
        seen[id] = true;
        groups.push({
          id: id,
          provider: typeof entry.provider === 'string' ? entry.provider : '*',
          model: typeof entry.model === 'string' ? entry.model : '*',
          enabled: entry.enabled !== false,
          region: normalizeRegion(entry.region),
          calendar: normalizeCalendar(entry.calendar),
          windows: normalizeWindows(entry.windows),
        });
      }
      return groups;
    }

    function defaultConfig() {
      return {
        version: 2,
        enabled: true,
        strategy: 'sequential',
        groups: [
          {
            id: 'default',
            provider: '*',
            model: '*',
            enabled: true,
            region: 'cn',
            calendar: 'legalWorkday',
            windows: [
              { start: '08:00', end: '12:00' },
              { start: '14:00', end: '18:00' },
            ],
          },
        ],
        calendarOverrides: {},
      };
    }

    /** True for the untouched v1 default row, so a fresh rule can replace it. */
    function isLegacyDefaultGroup(groups) {
      if (!Array.isArray(groups) || groups.length !== 1) return false;
      const group = groups[0];
      if (!group || group.enabled === false) return false;
      if (group.provider !== '*' || group.model !== '*') return false;
      if (group.calendar !== undefined || group.region !== undefined) return false;
      const windows = group.windows;
      return (
        Array.isArray(windows) &&
        windows.length === 1 &&
        windows[0] &&
        windows[0].start === '08:30' &&
        windows[0].end === '00:30'
      );
    }

    function normalizeConfig(raw) {
      if (!raw || typeof raw !== 'object') return defaultConfig();
      const groups = normalizeGroups(raw.groups);
      return {
        version: 2,
        enabled: raw.enabled !== false,
        strategy: raw.strategy === 'merge' ? 'merge' : 'sequential',
        groups: raw.version !== 2 && isLegacyDefaultGroup(raw.groups) ? defaultConfig().groups : groups,
        calendarOverrides: normalizeCalendarOverrides(raw.calendarOverrides),
      };
    }

    function normalizeName(value) {
      return typeof value === 'string' ? value.trim() : '';
    }

    function isWildcard(name) {
      return name === '' || name === '*';
    }

    /** First enabled row that covers `model`; wildcards match anything. */
    function matchGroup(groups, model) {
      const list = Array.isArray(groups) ? groups : [];
      for (const group of list) {
        if (!group || group.enabled === false) continue;
        const provider = normalizeName(group.provider);
        const name = normalizeName(group.model);
        if (model) {
          const providerOk =
            isWildcard(provider) || provider.toLowerCase() === String(model.provider || '').toLowerCase();
          const modelOk = isWildcard(name) || name.toLowerCase() === String(model.model || '').toLowerCase();
          if (providerOk && modelOk) return group;
        } else if (isWildcard(provider) && isWildcard(name)) {
          return group;
        }
      }
      return null;
    }

    function findGroup(groups, id) {
      const list = Array.isArray(groups) ? groups : [];
      for (const group of list) {
        if (group && group.id === id) return group;
      }
      return null;
    }

    function mergeTexts(items) {
      const texts = [];
      for (const item of items) {
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (text !== '') texts.push(text);
      }
      return texts.join('\n\n');
    }

    function normalizeQueue(raw) {
      const result = {};
      if (!raw || typeof raw !== 'object') return result;
      for (const key of Object.keys(raw)) {
        const list = raw[key];
        if (!Array.isArray(list)) continue;
        const items = [];
        for (const entry of list) {
          if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string') continue;
          items.push({
            id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : uid('msg'),
            text: entry.text,
            attachments: Array.isArray(entry.attachments)
              ? entry.attachments.filter(function (value) {
                  return typeof value === 'string';
                })
              : [],
            mode: entry.mode === 'steer' ? 'steer' : 'queue',
            groupId: typeof entry.groupId === 'string' ? entry.groupId : '',
            createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
            error: typeof entry.error === 'string' ? entry.error : '',
            attempts: typeof entry.attempts === 'number' && entry.attempts > 0 ? entry.attempts : 0,
          });
        }
        if (items.length > 0) result[key] = items;
      }
      return result;
    }

    function readStorage(key) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return null;
        return JSON.parse(raw);
      } catch (error) {
        return null;
      }
    }

    function writeStorage(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        /* storage may be unavailable or full; the queue stays in memory */
      }
    }

    function errorText(error) {
      if (error === undefined || error === null) return '';
      if (typeof error === 'string') return error;
      if (typeof error.message === 'string' && error.message !== '') return error.message;
      try {
        return String(error);
      } catch (inner) {
        return '';
      }
    }

    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      function publish() {
        const snapshot = Array.from(listeners);
        for (const listener of snapshot) {
          try {
            listener();
          } catch (error) {
            /* one broken subscriber must not stop the others */
          }
        }
      }
      return {
        get: function get() {
          return state;
        },
        set: function set(next) {
          if (next === state) return;
          state = next;
          publish();
        },
        update: function update(factory) {
          const next = factory(state);
          if (next && next !== state) {
            state = next;
            publish();
          }
        },
        subscribe: function subscribe(listener) {
          listeners.add(listener);
          return function unsubscribe() {
            listeners.delete(listener);
          };
        },
      };
    }

    function remoteFailed(result) {
      if (!result || typeof result !== 'object') return false;
      if (result.ok === false) return true;
      if (result.error !== undefined && result.error !== null) return true;
      return false;
    }

    const Pure = {
      parseClock: parseClock,
      formatClock: formatClock,
      isInWindowAt: isInWindowAt,
      durationParts: durationParts,
      normalizeConfig: normalizeConfig,
      normalizeQueue: normalizeQueue,
      defaultConfig: defaultConfig,
      matchGroup: matchGroup,
      findGroup: findGroup,
      mergeTexts: mergeTexts,
      normalizeGroups: normalizeGroups,
      normalizeWindows: normalizeWindows,
      // Calendar surface
      CALENDAR_TYPES: CALENDAR_TYPES,
      REGIONS: REGIONS,
      buildCalendarIndex: buildCalendarIndex,
      matchesCalendar: matchesCalendar,
      peakWindow: peakWindow,
      weekdayOfKey: weekdayOfKey,
      dateKeyOf: dateKeyOf,
      dateSpan: dateSpan,
      parseDateLines: parseDateLines,
      formatDateLines: formatDateLines,
      calendarYear: calendarYear,
      describeDate: describeDate,
      normalizeCalendarOverrides: normalizeCalendarOverrides,
    };

    /* ------------------------------------------------------------------ *
     * Copy                                                            *
     * ------------------------------------------------------------------ */

    const DICTS = {
      zh: {
        'unit.hour': '小时',
        'unit.minute': '分',
        'unit.second': '秒',
        'settings.nav': '错峰发送',
        'settings.title': '错峰发送',
        'settings.intro':
          '在峰价时段拦截发送，由你决定立刻发送、排队到谷价，还是放弃这条消息。峰价由「日历规则 + 时段」决定，只用本机时钟，不发起任何模型请求。',
        'settings.enableTitle': '启用拦截',
        'settings.enableDesc': '关闭后所有消息都会立即发送。',
        'settings.statusTitle': '运行状态',
        'settings.statusInstalled': '已接管发送路径：峰价时段发送会先询问你。',
        'settings.statusUnavailable': '未接管发送路径：conversation 服务不可用。',
        'settings.statusStopped': '已停止接管。',
        'settings.statusFailures': '加载时有步骤失败',
        'settings.strategyTitle': '排队发送策略',
        'settings.strategyDesc': '谷价开始后，队列如何释放。',
        'settings.strategyMerge': '合并成一条发送',
        'settings.strategyMergeDesc': '把排队的纯文本合并为一条消息；带附件的消息仍逐条发送。',
        'settings.strategySequential': '每轮对话结束后发送下一条',
        'settings.strategySequentialDesc': '先发送一条，等这一轮对话结束后再发下一条。',
        'settings.modelsTitle': '模型与峰价规则',
        'settings.modelsDesc':
          '每一组从模型目录里选择供应商与模型，并只在所选日历日、所选时段内算峰价。选「任意」表示不限制。',
        'settings.catalogReady': '模型目录已载入',
        'settings.providerCount': '个供应商',
        'settings.catalogLoading': '正在读取模型目录…',
        'settings.catalogUnavailable': '模型目录不可用：当前环境没有 remote.session.modelCatalog。',
        'settings.catalogError': '模型目录读取失败',
        'settings.catalogRetry': '重试',
        'settings.anyProvider': '任意供应商',
        'settings.anyModel': '任意模型',
        'settings.group': '第 {n} 组',
        'settings.provider': '供应商',
        'settings.model': '模型名称',
        'settings.calendar': '日历规则',
        'settings.windows': '峰价时段',
        'settings.addWindow': '添加时段',
        'settings.removeWindow': '删除',
        'settings.removeGroup': '删除这组',
        'settings.addModel': '添加模型',
        'settings.emptyGroups': '还没有任何模型组。添加一组后才会开始拦截。',
        'settings.timeHint':
          '时段按本机时钟判断；跨零点的时段请把结束时间写得早于开始时间（例如 22:00 → 06:00）。规则只在匹配的日历日生效。',
        'settings.toggleGroup': '启用这一组',
        'settings.today': '今天',
        'settings.todayMatch': '命中该日历规则',
        'settings.todayMiss': '不命中该日历规则',
        'settings.nowLine': '此刻',
        'settings.nowPeak': '峰价',
        'settings.nowOff': '非峰价',
        'settings.applyOfficial': '套用 DeepSeek 官方峰价',
        'weekday.sun': '周日',
        'weekday.mon': '周一',
        'weekday.tue': '周二',
        'weekday.wed': '周三',
        'weekday.thu': '周四',
        'weekday.fri': '周五',
        'weekday.sat': '周六',
        'day.holiday': '法定节假日',
        'day.makeup': '调休上班日',
        'day.weekend': '周末',
        'day.plain': '普通工作日',
        'calendar.hint.everyday': '与日历无关，任何一天都按下面的时段判断。',
        'calendar.hint.legalWorkday': '周一至周五，排除法定节假日；调休上班日算上班。',
        'calendar.hint.legalHoliday': '国务院公布的放假日；调休上班日不算。',
        'calendar.hint.weekend': '只看周六、周日，不看节假日安排。',
        'calendar.hint.weekday': '只看周一到周五，不看节假日安排。',
        'settings.dataTitle': '中国大陆节假日数据',
        'settings.dataDesc':
          '内置 2024–2027 年国务院公布的放假调休安排。未来年份可在这里补充，官方数据有变动时也可直接改；自定义数据优先于内置数据。',
        'settings.official': '官方',
        'settings.custom': '自定义',
        'settings.holidayDays': '个节假日',
        'settings.makeupDays': '个调休上班日',
        'settings.edit': '编辑',
        'settings.cancel': '取消',
        'settings.save': '保存',
        'settings.reset': '恢复内置',
        'settings.holidayList': '法定节假日（每行 YYYY-MM-DD 或 YYYY-MM-DD 名称）',
        'settings.makeupList': '调休上班日（每行 YYYY-MM-DD）',
        'settings.addYear': '添加年份',
        'calendar.everyday': '每天',
        'calendar.legalWorkday': '法定工作日',
        'calendar.legalHoliday': '法定节假日',
        'calendar.weekend': '周末',
        'calendar.weekday': '周一至周五（不看节假日）',
        'region.cn': '中国大陆',
        'modal.title': '现在是峰价时段',
        'modal.body': '当前模型命中峰价时段。',
        'modal.countdown': '距谷价开始还有',
        'modal.preview': '将发送的内容',
        'modal.cancel': '算了',
        'modal.now': '现在做',
        'modal.later': '等等再做',
        'modal.cancelled': '已取消发送：当前处于峰价时段。',
        'modal.unknownModel': '当前模型',
        'dock.title': '错峰队列',
        'dock.count': '条',
        'dock.waiting': '等待谷价',
        'dock.ready': '即将发送',
        'dock.remove': '移除',
        'dock.clear': '清空',
        'dock.retry': '重试',
        'dock.failed': '发送失败',
        'dock.attachments': '附件',
        'dock.stopped': '已停止重试',
      },
      en: {
        'unit.hour': 'h',
        'unit.minute': 'min',
        'unit.second': 's',
        'settings.nav': 'Off-peak send',
        'settings.title': 'Off-peak send',
        'settings.intro':
          'Hold a message when its model is inside a peak rule, then send it now, queue it until off-peak, or discard it. A peak rule is a calendar rule plus time windows, decided with the local clock only.',
        'settings.enableTitle': 'Enable interception',
        'settings.enableDesc': 'When off, every message is sent immediately.',
        'settings.statusTitle': 'Runtime status',
        'settings.statusInstalled': 'Guarding the composer: a peak-window send asks first.',
        'settings.statusUnavailable': 'Not guarding: the conversation service is unavailable.',
        'settings.statusStopped': 'Guard stopped.',
        'settings.statusFailures': 'Some steps failed while loading',
        'settings.strategyTitle': 'Queue delivery',
        'settings.strategyDesc': 'How queued messages are released once off-peak starts.',
        'settings.strategyMerge': 'Combine into one message',
        'settings.strategyMergeDesc':
          'Join queued text into a single message; messages with attachments are still sent one at a time.',
        'settings.strategySequential': 'Send the next one after each turn',
        'settings.strategySequentialDesc':
          'Send one queued message, wait for its turn to finish, then send the next.',
        'settings.modelsTitle': 'Models and peak rules',
        'settings.modelsDesc':
          'Each row picks a provider and model from the model catalog, and counts as peak only on the chosen calendar days inside its windows. "Any" leaves that side unrestricted.',
        'settings.catalogReady': 'Model catalog loaded',
        'settings.providerCount': 'providers',
        'settings.catalogLoading': 'Loading the model catalog…',
        'settings.catalogUnavailable': 'Model catalog unavailable: this environment has no remote.session.modelCatalog.',
        'settings.catalogError': 'Could not load the model catalog',
        'settings.catalogRetry': 'Retry',
        'settings.anyProvider': 'Any provider',
        'settings.anyModel': 'Any model',
        'settings.group': 'Group {n}',
        'settings.provider': 'Provider',
        'settings.model': 'Model',
        'settings.calendar': 'Calendar rule',
        'settings.windows': 'Peak windows',
        'settings.addWindow': 'Add window',
        'settings.removeWindow': 'Remove',
        'settings.removeGroup': 'Remove group',
        'settings.addModel': 'Add model',
        'settings.emptyGroups': 'No model rows yet. Nothing is intercepted until you add one.',
        'settings.timeHint':
          'Windows use the local clock; a window crossing midnight ends earlier than it starts (e.g. 22:00 → 06:00). Rules only apply on matching calendar days.',
        'settings.toggleGroup': 'Enable this row',
        'settings.today': 'Today',
        'settings.todayMatch': 'matches this calendar rule',
        'settings.todayMiss': 'does not match this calendar rule',
        'settings.nowLine': 'now',
        'settings.nowPeak': 'peak',
        'settings.nowOff': 'off-peak',
        'settings.applyOfficial': 'Use DeepSeek official peak hours',
        'weekday.sun': 'Sun',
        'weekday.mon': 'Mon',
        'weekday.tue': 'Tue',
        'weekday.wed': 'Wed',
        'weekday.thu': 'Thu',
        'weekday.fri': 'Fri',
        'weekday.sat': 'Sat',
        'day.holiday': 'statutory holiday',
        'day.makeup': 'make-up workday',
        'day.weekend': 'weekend',
        'day.plain': 'ordinary workday',
        'calendar.hint.everyday': 'Every day uses the windows below, whatever the calendar says.',
        'calendar.hint.legalWorkday': 'Monday to Friday, excluding statutory holidays; make-up workdays count.',
        'calendar.hint.legalHoliday': 'Days the State Council publishes as holidays; make-up workdays do not count.',
        'calendar.hint.weekend': 'Saturdays and Sundays only, ignoring the holiday table.',
        'calendar.hint.weekday': 'Monday to Friday only, ignoring the holiday table.',
        'settings.dataTitle': 'Mainland China holiday data',
        'settings.dataDesc':
          'Built in: the State Council arrangements for 2024–2027. Add future years here, or edit any year when the official notice changes; custom data wins over the built-in table.',
        'settings.official': 'Official',
        'settings.custom': 'Custom',
        'settings.holidayDays': 'holidays',
        'settings.makeupDays': 'make-up workdays',
        'settings.edit': 'Edit',
        'settings.cancel': 'Cancel',
        'settings.save': 'Save',
        'settings.reset': 'Restore built-in',
        'settings.holidayList': 'Statutory holidays (one `YYYY-MM-DD` or `YYYY-MM-DD name` per line)',
        'settings.makeupList': 'Make-up workdays (one `YYYY-MM-DD` per line)',
        'settings.addYear': 'Add year',
        'calendar.everyday': 'Every day',
        'calendar.legalWorkday': 'Statutory workday',
        'calendar.legalHoliday': 'Statutory holiday',
        'calendar.weekend': 'Weekend',
        'calendar.weekday': 'Monday–Friday (holidays ignored)',
        'region.cn': 'Mainland China',
        'modal.title': 'Peak pricing now',
        'modal.body': 'The current model is inside a peak-pricing window.',
        'modal.countdown': 'Off-peak starts in',
        'modal.preview': 'Message',
        'modal.cancel': 'Discard',
        'modal.now': 'Send now',
        'modal.later': 'Queue it',
        'modal.cancelled': 'Not sent: peak pricing is active.',
        'modal.unknownModel': 'current model',
        'dock.title': 'Off-peak queue',
        'dock.count': 'queued',
        'dock.waiting': 'waiting',
        'dock.ready': 'ready',
        'dock.remove': 'Remove',
        'dock.clear': 'Clear',
        'dock.retry': 'Retry',
        'dock.failed': 'Send failed',
        'dock.attachments': 'attachments',
        'dock.stopped': 'stopped',
      },
    };

    function lookup(dict, key) {
      const path = String(key).split('.');
      let node = dict;
      for (const part of path) {
        if (!node || typeof node !== 'object') return undefined;
        node = node[part];
      }
      return typeof node === 'string' ? node : undefined;
    }

    function makeTranslate(dict) {
      return function translate(key) {
        const value = lookup(dict, key);
        return value === undefined ? key : value;
      };
    }

    /* ------------------------------------------------------------------ *
     * Styles                                                          *
     * ------------------------------------------------------------------ */

    const CSS = [
      '.op-sect{display:flex;flex-direction:column;gap:18px;padding:6px 0 20px}',
      '.op-head{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.op-title{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.op-sub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.op-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.op-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.op-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 14px}',
      '.op-row+.op-row{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.op-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;text-align:left}',
      '.op-row-title{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.op-row-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.op-switch{position:relative;flex:none;width:34px;height:20px;border-radius:999px;border:none;cursor:pointer;background:var(--dsw-alias-border-l2);padding:0;transition:background .15s ease}',
      '.op-switch[data-on="true"]{background:var(--dsw-alias-brand-primary)}',
      '.op-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.22)}',
      '.op-switch[data-on="true"] .op-knob{transform:translateX(14px)}',
      '.op-choice{display:flex;align-items:flex-start;gap:10px;width:100%;padding:12px 14px;border:none;background:transparent;font:inherit;cursor:pointer;text-align:left}',
      '.op-choice+.op-choice{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.op-choice:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}',
      '.op-radio{flex:none;width:14px;height:14px;margin-top:3px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);box-sizing:border-box;display:flex;align-items:center;justify-content:center}',
      '.op-choice[data-active="true"] .op-radio{border-color:var(--dsw-alias-brand-primary)}',
      '.op-radio-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary)}',
      '.op-group-list{display:flex;flex-direction:column;gap:10px}',
      '.op-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.op-group[data-on="false"]{opacity:.66}',
      '.op-group-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.op-group-body{display:flex;flex-direction:column;gap:10px;padding:10px 14px 12px}',
      '.op-fields{display:flex;gap:8px;flex-wrap:wrap}',
      '.op-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.op-fields>.op-field{flex:1 1 140px}',
      '.op-field-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.op-input{width:100%;box-sizing:border-box;height:30px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
      '.op-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.op-input::placeholder{color:var(--dsw-alias-label-secondary)}',
      '.op-window{display:flex;align-items:center;gap:8px}',
      '.op-time{width:84px;flex:none;text-align:center;font-variant-numeric:tabular-nums}',
      '.op-arrow{color:var(--dsw-alias-label-secondary);font-size:12px;flex:none}',
      '.op-link{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:4px 6px;border-radius:6px;white-space:nowrap}',
      '.op-link:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}',
      '.op-link-danger:hover{color:var(--dsw-alias-state-error-primary)}',
      '.op-add{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;height:34px;border-radius:9px;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}',
      '.op-add:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '.op-btn{height:32px;padding:0 14px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}',
      '.op-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.op-btn:disabled{opacity:.5;cursor:default}',
      '.op-btn-primary{background:var(--dsw-alias-brand-primary);color:#fff}',
      '.op-btn-primary:hover{background:var(--dsw-alias-brand-primary);filter:brightness(1.07)}',
      '.op-btn-secondary{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}',
      '.op-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto}',
      '.op-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.36));backdrop-filter:var(--dsw-mask-blur,blur(2px))}',
      '.op-modal{position:relative;z-index:1;width:min(440px,100%);box-sizing:border-box;border-radius:var(--dsw-radius-panel,14px);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-overlay));box-shadow:var(--dsw-elevation-prominent,0 24px 64px rgba(0,0,0,.3));padding:18px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}',
      '.op-modal-head{display:flex;align-items:flex-start;gap:10px}',
      '.op-modal-icon{flex:none;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.op-modal-title{margin:0;font-size:15px;line-height:22px;font-weight:500}',
      '.op-modal-close{flex:none;width:26px;height:26px;margin-left:auto;padding:0;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}',
      '.op-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}',
      '.op-modal-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.op-modal-count{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.op-quote{border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);padding:8px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);max-height:80px;overflow:hidden;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}',
      '.op-modal-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:2px}',
      '.op-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;flex:none;display:flex;flex-direction:column}',
      '.op-dock-panel{border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(12px));box-shadow:var(--dsw-elevation-panel,0 2px 10px rgba(0,0,0,.08));overflow:hidden;border:0}',
      '.op-dock-head{display:flex;align-items:center;gap:10px;width:100%;height:36px;padding:0 12px;border:none;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;font-weight:500;line-height:24px;text-align:left}',
      '.op-dock-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}',
      '.op-dock-lead{color:var(--dsw-alias-label-secondary);flex:none;display:grid;place-items:center}',
      '.op-dock-count{color:var(--dsw-alias-label-primary);flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.op-dock-chevron{color:var(--dsw-alias-label-secondary);flex:none;font-size:11px;line-height:1}',
      '.op-dock-list{list-style:none;margin:0;padding:0;max-height:180px;overflow-y:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      '.op-dock-row{display:flex;align-items:center;gap:10px;padding:4px 12px;min-height:36px;box-sizing:border-box;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.op-dock-row+.op-dock-row{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}',
      '.op-dock-text{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.op-dock-note{color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;font-size:12px}',
      '.op-dock-error{color:var(--dsw-alias-state-error-primary)}',
      '.op-dock-action{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;padding:2px 6px;border-radius:6px;white-space:nowrap;flex:none}',
      '.op-dock-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}',
      '.op-dock-foot{display:flex;justify-content:flex-end;padding:2px 8px 6px}',
      '.op-status-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);margin-right:2px}',
      '.op-status-dot[data-ok="true"]{background:var(--dsw-alias-state-success-primary)}',
      '.op-select-wrap{position:relative;display:flex;align-items:center;flex:1 1 auto;min-width:0;width:100%}',
      '.op-select{appearance:none;-webkit-appearance:none;padding-right:26px;cursor:pointer}',
      '.op-select-caret{position:absolute;right:9px;pointer-events:none;font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary)}',
      '.op-region{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding-left:8px}',
      '.op-textarea{width:100%;box-sizing:border-box;min-height:88px;padding:8px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:vertical;outline:none}',
      '.op-textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.op-data-body{display:flex;flex-direction:column;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.op-data-actions{display:flex;justify-content:flex-end;gap:8px}',
      '.op-year{font-variant-numeric:tabular-nums}',
      '.op-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.op-chip{height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}',
      '.op-chip:hover{border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary)}',
      '.op-chip[data-on="true"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-label-primary)}',
    ].join('');

    function installStyles() {
      if (typeof document === 'undefined') return function () {};
      const tagId = PLUGIN_ID + '/client.css';
      const selector = 'style[data-plugin-css="' + tagId + '"]';
      if (document.querySelector(selector) !== null) return function () {};
      const tag = document.createElement('style');
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return function () {
        if (tag.parentNode) tag.parentNode.removeChild(tag);
      };
    }

    /* ------------------------------------------------------------------ *
     * Runtime                                                          *
     * ------------------------------------------------------------------ */

    function createRuntime(ctx) {
      const stored = readStorage(CONFIG_KEY);
      const store = createStore({
        config: normalizeConfig(stored) || defaultConfig(),
        queues: normalizeQueue(readStorage(QUEUE_KEY)),
        confirms: [],
        catalog: { status: 'idle', providers: [], error: '' },
      });
      const clock = createStore(Date.now());
      let pumping = false;
      let catalogLoading = false;
      const lastSent = {};
      const timers = [];

      const runtime = {
        ctx: ctx,
        store: store,
        clock: clock,
        t: makeTranslate(DICTS.zh),
        /** Bound copy of the unguarded submission method, set by the interceptor. */
        originalSendSession: null,
        /** `pending` before install, then `installed` or `unavailable`. */
        interceptorState: 'pending',
        /** `{ signature, index }` for the merged calendar data. */
        calendarCache: null,
        /** Load-time failures kept for the settings page; never fatal. */
        failures: [],

        /** Record one non-fatal failure once per step. */
        recordFailure: function recordFailure(step, error) {
          try {
            const label = String(step || 'step');
            const exists = runtime.failures.some(function (entry) {
              return entry.step === label;
            });
            if (exists) return;
            runtime.failures.push({ step: label, message: errorText(error) });
          } catch (inner) {}
        },

        /**
         * Load the Host model catalog once (provider groups + models).
         *
         * A client plugin can activate before the Host connection exists, and the
         * generated Remote namespace may then throw synchronously instead of
         * rejecting; every path here is caught so activation never fails on it.
         */
        ensureCatalog: function ensureCatalog(force) {
          try {
            const current = store.get().catalog || { status: 'idle' };
            if (!force && catalogLoading) return;
            if (!force && current.status === 'ready') return;
            const namespace = ctx.get('remote.session');
            if (!namespace || typeof namespace.modelCatalog !== 'function') {
              store.update(function (state) {
                return Object.assign({}, state, {
                  catalog: {
                    status: 'unavailable',
                    providers: state.catalog ? state.catalog.providers : [],
                    error: '',
                  },
                });
              });
              return;
            }
            catalogLoading = true;
            store.update(function (state) {
              return Object.assign({}, state, {
                catalog: {
                  status: 'loading',
                  providers: state.catalog ? state.catalog.providers : [],
                  error: '',
                },
              });
            });
            let request = null;
            try {
              request = namespace.modelCatalog();
            } catch (error) {
              catalogLoading = false;
              throw error;
            }
            Promise.resolve(request)
              .then(function (result) {
                if (result && result.ok === false) {
                  throw new Error(errorText(result.error) || 'model catalog failed');
                }
                const groups = result && result.value && Array.isArray(result.value.groups) ? result.value.groups : [];
                const providers = groups
                  .filter(function (group) {
                    return group && typeof group.id === 'string';
                  })
                  .map(function (group) {
                    const models = Array.isArray(group.models) ? group.models : [];
                    return {
                      id: String(group.id),
                      name: typeof group.name === 'string' && group.name !== '' ? group.name : String(group.id),
                      models: models
                        .filter(function (model) {
                          return model && typeof model.id === 'string';
                        })
                        .map(function (model) {
                          return {
                            id: String(model.id),
                            name:
                              typeof model.name === 'string' && model.name !== ''
                                ? model.name
                                : String(model.id),
                          };
                        }),
                    };
                  });
                store.update(function (state) {
                  return Object.assign({}, state, {
                    catalog: { status: 'ready', providers: providers, error: '' },
                  });
                });
              })
              .catch(function (error) {
                store.update(function (state) {
                  return Object.assign({}, state, {
                    catalog: { status: 'error', providers: [], error: errorText(error) },
                  });
                });
              })
              .then(function () {
                catalogLoading = false;
              });
          } catch (error) {
            catalogLoading = false;
            runtime.recordFailure('catalog', error);
            try {
              store.update(function (state) {
                return Object.assign({}, state, {
                  catalog: { status: 'error', providers: [], error: errorText(error) },
                });
              });
            } catch (inner) {}
          }
        },

        installLocale: function installLocale() {
          const locale = ctx.get('locale');
          if (!locale || typeof locale.bind !== 'function') return function () {};
          const disposers = [];
          if (typeof locale.register === 'function') {
            const bundle = {
              zh: DICTS.zh,
              'zh-CN': DICTS.zh,
              en: DICTS.en,
              'en-US': DICTS.en,
            };
            for (const lang of Object.keys(bundle)) {
              try {
                const dispose = locale.register(NS, lang, bundle[lang]);
                if (typeof dispose === 'function') disposers.push(dispose);
              } catch (error) {
                /* an already-registered locale keeps the existing dictionary */
              }
            }
          }
          try {
            runtime.t = locale.bind(NS);
          } catch (error) {
            runtime.t = makeTranslate(DICTS.zh);
          }
          return function () {
            for (const dispose of disposers) {
              try {
                dispose();
              } catch (error) {}
            }
          };
        },

        persistConfig: function persistConfig() {
          writeStorage(CONFIG_KEY, store.get().config);
        },

        persistQueues: function persistQueues() {
          writeStorage(QUEUE_KEY, store.get().queues);
        },

        patchConfig: function patchConfig(patch) {
          const next = normalizeConfig(Object.assign({}, store.get().config, patch));
          store.update(function (state) {
            return Object.assign({}, state, { config: next });
          });
          writeStorage(CONFIG_KEY, next);
        },

        mutateConfig: function mutateConfig(mutator) {
          const next = normalizeConfig(mutator(store.get().config));
          store.update(function (state) {
            return Object.assign({}, state, { config: next });
          });
          writeStorage(CONFIG_KEY, next);
        },

        readModel: function readModel(session) {
          try {
            const face = session && session.projections && session.projections.faceOf('modelSelection');
            const value = face && typeof face.getSnapshot === 'function' ? face.getSnapshot() : undefined;
            const selection =
              value && typeof value === 'object'
                ? value.next !== undefined
                  ? value.next
                  : value.lastUsed !== undefined
                    ? value.lastUsed
                    : value
                : undefined;
            if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
              return { provider: selection.provider, model: selection.model };
            }
          } catch (error) {}
          try {
            const directories = ctx.get('modelDirectories');
            const sessionId = session && session.sessionId;
            if (directories && typeof directories.directoryFor === 'function' && sessionId) {
              const directory = directories.directoryFor(sessionId);
              const current = directory && directory.store && directory.store.getSnapshot().current;
              if (current && typeof current.provider === 'string' && typeof current.model === 'string') {
                return { provider: current.provider, model: current.model };
              }
            }
          } catch (error) {}
          return null;
        },

        /** Deliver through the unguarded method so a released queue row never re-guards. */
        callOriginalSendSession: function callOriginalSendSession(session, text, attachments, mode) {
          if (typeof runtime.originalSendSession === 'function') {
            return runtime.originalSendSession(session, text, attachments, mode);
          }
          const conversation = ctx.get('conversation');
          if (!conversation) return Promise.reject(new Error('conversation service unavailable'));
          return conversation.sendSession(session, text, attachments, mode);
        },

        requestDecision: function requestDecision(request) {
          return new Promise(function (resolve) {
            const id = uid('confirm');
            const modelLabel = request.model
              ? String(request.model.provider) + ' / ' + String(request.model.model)
              : '';
            const confirm = {
              id: id,
              sessionId: request.sessionId,
              text: typeof request.text === 'string' ? request.text : '',
              attachments: Array.isArray(request.attachments) ? request.attachments.slice() : [],
              mode: request.mode === 'steer' ? 'steer' : 'queue',
              groupId: request.groupId,
              windowLabel:
                request.window && typeof request.window.start === 'string' && typeof request.window.end === 'string'
                  ? String(request.window.start) + ' - ' + String(request.window.end)
                  : '',
              calendar: typeof request.calendar === 'string' ? request.calendar : 'everyday',
              anchorDate: typeof request.anchorDate === 'string' ? request.anchorDate : '',
              endsAt: request.endsAt,
              modelLabel: modelLabel,
              createdAt: Date.now(),
              settled: false,
              resolve: resolve,
              deliver: request.deliver,
              discard: request.discard,
            };
            store.update(function (state) {
              return Object.assign({}, state, { confirms: state.confirms.concat([confirm]) });
            });
            if (request.signal && typeof request.signal.addEventListener === 'function') {
              const onAbort = function () {
                runtime.resolveConfirm(id, 'cancel');
              };
              try {
                request.signal.addEventListener('abort', onAbort, { once: true });
                timers.push(function () {
                  try {
                    request.signal.removeEventListener('abort', onAbort);
                  } catch (error) {}
                });
              } catch (error) {}
            }
          });
        },

        resolveConfirm: function resolveConfirm(id, decision) {
          const state = store.get();
          let confirm = null;
          for (const entry of state.confirms) {
            if (entry.id === id) confirm = entry;
          }
          if (!confirm || confirm.settled) return;
          confirm.settled = true;
          store.update(function (current) {
            return Object.assign({}, current, {
              confirms: current.confirms.filter(function (entry) {
                return entry.id !== id;
              }),
            });
          });
          if (decision === 'now') {
            confirm.resolve(Promise.resolve().then(function () {
              return confirm.deliver();
            }));
            return;
          }
          if (decision === 'later') {
            runtime.enqueue(confirm);
            confirm.resolve({ kind: 'success' });
            return;
          }
          if (typeof confirm.discard === 'function') {
            try {
              confirm.discard();
            } catch (error) {}
          }
          confirm.resolve({ kind: 'error', text: runtime.t('modal.cancelled') });
        },

        enqueue: function enqueue(confirm) {
          const sessionId = confirm.sessionId || 'unknown';
          const item = {
            id: uid('msg'),
            text: confirm.text,
            attachments: confirm.attachments.slice(),
            mode: confirm.mode,
            groupId: confirm.groupId,
            createdAt: Date.now(),
            error: '',
            attempts: 0,
          };
          store.update(function (state) {
            const existing = state.queues[sessionId] || [];
            const queues = Object.assign({}, state.queues);
            queues[sessionId] = existing.concat([item]);
            return Object.assign({}, state, { queues: queues });
          });
          runtime.persistQueues();
        },

        removeItems: function removeItems(sessionId, ids) {
          const drop = new Set(ids);
          store.update(function (state) {
            const existing = state.queues[sessionId];
            if (!existing) return state;
            const remaining = existing.filter(function (item) {
              return !drop.has(item.id);
            });
            const queues = Object.assign({}, state.queues);
            if (remaining.length) queues[sessionId] = remaining;
            else delete queues[sessionId];
            return Object.assign({}, state, { queues: queues });
          });
          runtime.persistQueues();
        },

        clearQueue: function clearQueue(sessionId) {
          store.update(function (state) {
            const queues = Object.assign({}, state.queues);
            delete queues[sessionId];
            return Object.assign({}, state, { queues: queues });
          });
          runtime.persistQueues();
        },

        markItemError: function markItemError(sessionId, itemId, message) {
          const text = String(message || '').slice(0, 240);
          store.update(function (state) {
            const existing = state.queues[sessionId];
            if (!existing) return state;
            const queues = Object.assign({}, state.queues);
            queues[sessionId] = existing.map(function (item) {
              return item.id === itemId
                ? Object.assign({}, item, { error: text, attempts: (item.attempts || 0) + 1 })
                : item;
            });
            return Object.assign({}, state, { queues: queues });
          });
          runtime.persistQueues();
        },

        clearItemError: function clearItemError(sessionId, itemId) {
          store.update(function (state) {
            const existing = state.queues[sessionId];
            if (!existing) return state;
            const queues = Object.assign({}, state.queues);
            queues[sessionId] = existing.map(function (item) {
              return item.id === itemId ? Object.assign({}, item, { error: '', attempts: 0 }) : item;
            });
            return Object.assign({}, state, { queues: queues });
          });
          runtime.persistQueues();
        },

        /** Whether this row may be sent automatically right now. */
        isSendable: function isSendable(item) {
          if (item.error && (item.attempts || 0) >= MAX_ATTEMPTS) return false;
          return true;
        },

        /** Cached calendar lookup rebuilt whenever the overrides change. */
        calendarIndex: function calendarIndex() {
          const overrides = store.get().config.calendarOverrides || {};
          const signature = JSON.stringify(overrides);
          if (runtime.calendarCache === null || runtime.calendarCache.signature !== signature) {
            runtime.calendarCache = {
              signature: signature,
              index: buildCalendarIndex(overrides),
            };
          }
          return runtime.calendarCache.index;
        },

        /** When one queued item becomes sendable (0 = already off-peak). */
        readyAt: function readyAt(item, now) {
          const config = store.get().config;
          const group = findGroup(config.groups, item.groupId);
          if (!group || group.enabled === false) return 0;
          const hit = peakWindow(now, group.windows, group.calendar, runtime.calendarIndex());
          return hit ? hit.endsAt : 0;
        },

        sendQueueItem: function sendQueueItem(sessionId, item) {
          return runtime.sendQueueItemInner(sessionId, item);
        },

        sendQueueItemInner: function sendQueueItemInner(sessionId, item) {
          return runtime.retainSession(sessionId).then(function (reference) {
            if (!reference) throw new Error('session is no longer available');
            return Promise.resolve(reference.ready).then(
              function () {
                const session = reference.binding && reference.binding.session;
                if (!session) {
                  reference.release();
                  throw new Error('session is no longer available');
                }
                const snapshot = typeof session.getSnapshot === 'function' ? session.getSnapshot() : null;
                if (snapshot && snapshot.running) {
                  reference.release();
                  return { kind: 'busy' };
                }
                const pending = runtime.callOriginalSendSession(session, item.text, item.attachments, 'queue');
                return Promise.resolve(pending).then(
                  function () {
                    reference.release();
                    lastSent[sessionId] = Date.now();
                    runtime.removeItems(sessionId, [item.id]);
                    return { kind: 'sent' };
                  },
                  function (error) {
                    if (item.attachments && item.attachments.length > 0) {
                      return Promise.resolve()
                        .then(function () {
                          return session.prompt([{ type: 'text', text: item.text }], 'queue');
                        })
                        .then(
                          function (result) {
                            reference.release();
                            if (remoteFailed(result)) {
                              throw new Error(errorText(result && result.error));
                            }
                            lastSent[sessionId] = Date.now();
                            runtime.removeItems(sessionId, [item.id]);
                            return { kind: 'sent' };
                          },
                          function (innerError) {
                            reference.release();
                            throw innerError;
                          }
                        );
                    }
                    reference.release();
                    throw error;
                  }
                );
              },
              function (openError) {
                reference.release();
                throw openError;
              }
            );
          });
        },

        retainSession: function retainSession(sessionId) {
          const sessions = ctx.get('sessions');
          if (!sessions || typeof sessions.retain !== 'function') return Promise.resolve(null);
          try {
            return Promise.resolve(sessions.retain(sessionId, { source: 'controllerOperation' }));
          } catch (error) {
            return Promise.reject(error);
          }
        },

        pump: function pump() {
          if (pumping) return Promise.resolve();
          const state = store.get();
          const config = state.config;
          const calendar = runtime.calendarIndex();
          const now = Date.now();
          const plan = [];
          for (const sessionId of Object.keys(state.queues)) {
            const items = state.queues[sessionId];
            if (!items || items.length === 0) continue;
            const ready = items.filter(function (item) {
              if (!runtime.isSendable(item)) return false;
              const group = findGroup(config.groups, item.groupId);
              if (!group || group.enabled === false) return true;
              return peakWindow(now, group.windows, group.calendar, calendar) === null;
            });
            if (ready.length === 0) continue;
            if (now - (lastSent[sessionId] || 0) < SEND_COOLDOWN) continue;
            plan.push({ sessionId: sessionId, ready: ready });
          }
          if (plan.length === 0) return Promise.resolve();
          pumping = true;
          const run = async function () {
            for (const entry of plan) {
              try {
                await runtime.dispatch(entry.sessionId, entry.ready, config.strategy);
              } catch (error) {
                /* per-item failures are recorded below */
              }
            }
          };
          return run().then(
            function () {
              pumping = false;
            },
            function () {
              pumping = false;
            }
          );
        },

        dispatch: async function dispatch(sessionId, ready, strategy) {
          if (strategy === 'merge') {
            const textOnly = ready.filter(function (item) {
              return !item.attachments || item.attachments.length === 0;
            });
            const merged = mergeTexts(textOnly);
            if (merged !== '') {
              try {
                await runtime.sendMerged(sessionId, merged, textOnly);
                return;
              } catch (error) {
                for (const item of textOnly) {
                  runtime.markItemError(sessionId, item.id, errorText(error));
                }
                return;
              }
            }
            const withFiles = ready.filter(function (item) {
              return item.attachments && item.attachments.length > 0;
            });
            if (withFiles.length > 0) {
              await runtime.dispatchSingle(sessionId, withFiles[0]);
            }
            return;
          }
          await runtime.dispatchSingle(sessionId, ready[0]);
        },

        dispatchSingle: function dispatchSingle(sessionId, item) {
          return runtime
            .sendQueueItem(sessionId, item)
            .then(function (outcome) {
              if (!outcome || outcome.kind !== 'busy') return;
            })
            .catch(function (error) {
              runtime.markItemError(sessionId, item.id, errorText(error) || 'send failed');
            });
        },

        sendMerged: function sendMerged(sessionId, text, items) {
          return runtime.retainSession(sessionId).then(function (reference) {
            if (!reference) throw new Error('session is no longer available');
            return Promise.resolve(reference.ready).then(
              function () {
                const session = reference.binding && reference.binding.session;
                if (!session) {
                  reference.release();
                  throw new Error('session is no longer available');
                }
                const snapshot = typeof session.getSnapshot === 'function' ? session.getSnapshot() : null;
                if (snapshot && snapshot.running) {
                  reference.release();
                  return;
                }
                return Promise.resolve(runtime.callOriginalSendSession(session, text, [], 'queue')).then(
                  function () {
                    reference.release();
                    lastSent[sessionId] = Date.now();
                    runtime.removeItems(
                      sessionId,
                      items.map(function (item) {
                        return item.id;
                      })
                    );
                  },
                  function (error) {
                    reference.release();
                    throw error;
                  }
                );
              },
              function (openError) {
                reference.release();
                throw openError;
              }
            );
          });
        },

        /** Wrap `conversation.sendSession`; returns the restore function. */
        installInterceptor: function installInterceptor() {
          const conversation = ctx.get('conversation');
          if (!conversation) {
            runtime.interceptorState = 'unavailable';
            return function () {};
          }
          let proto = null;
          try {
            proto = Object.getPrototypeOf(conversation);
          } catch (error) {
            proto = null;
          }
          if (!proto || typeof proto.sendSession !== 'function') {
            runtime.interceptorState = 'unavailable';
            return function () {};
          }
          const original = proto.sendSession;
          runtime.originalSendSession = function (session, text, attachmentIds, mode) {
            return original.call(conversation, session, text, attachmentIds, mode);
          };
          function guarded(session, text, attachmentIds, mode, signal, accept) {
            const pass = function () {
              return original.call(conversation, session, text, attachmentIds, mode, signal, accept);
            };
            try {
              const config = store.get().config;
              if (!config.enabled) return pass();
              const model = runtime.readModel(session);
              const group = matchGroup(config.groups, model);
              if (!group) return pass();
              const hit = peakWindow(Date.now(), group.windows, group.calendar, runtime.calendarIndex());
              if (!hit) return pass();
              const sessionId = (session && session.sessionId) || '';
              return runtime.requestDecision({
                sessionId: sessionId,
                text: text,
                attachments: attachmentIds,
                mode: mode,
                groupId: group.id,
                window: hit.window,
                calendar: group.calendar,
                anchorDate: hit.anchorDate,
                endsAt: hit.endsAt,
                model: model,
                signal: signal,
                deliver: function () {
                  return original.call(conversation, session, text, attachmentIds, mode, signal, accept);
                },
                discard: function () {
                  /* the composer keeps the draft on an error outcome */
                },
              });
            } catch (error) {
              return pass();
            }
          }
          proto.sendSession = guarded;
          runtime.interceptorState = 'installed';
          return function () {
            if (proto.sendSession === guarded) proto.sendSession = original;
            if (runtime.originalSendSession !== null) runtime.originalSendSession = null;
            runtime.interceptorState = 'stopped';
          };
        },

        startClock: function startClock() {
          const tick = function () {
            try {
              clock.set(Date.now());
              runtime.pump();
            } catch (error) {
              runtime.recordFailure('tick', error);
            }
          };
          tick();
          const handle = setInterval(tick, 1000);
          if (handle && typeof handle.unref === 'function') handle.unref();
          return function () {
            clearInterval(handle);
            for (const dispose of timers) {
              try {
                dispose();
              } catch (error) {}
            }
            timers.length = 0;
          };
        },

        /** Tear down everything and settle open prompts as discarded. */
        teardown: function teardown() {
          const state = store.get();
          for (const confirm of state.confirms) {
            if (!confirm.settled) {
              confirm.settled = true;
              try {
                confirm.resolve({ kind: 'error', text: runtime.t('modal.cancelled') });
              } catch (error) {}
            }
          }
          store.update(function (current) {
            return Object.assign({}, current, { confirms: [] });
          });
        },
      };

      return runtime;
    }

    /* ------------------------------------------------------------------ *
     * UI                                                               *
     * ------------------------------------------------------------------ */

    function useSnapshot(store) {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(store.subscribe, store.get, store.get);
      }
      const pair = React.useState(store.get());
      const value = pair[0];
      const setValue = pair[1];
      React.useEffect(
        function () {
          return store.subscribe(function () {
            setValue(store.get());
          });
        },
        [store, setValue]
      );
      return value;
    }

    function humanDuration(runtime, ms) {
      const parts = durationParts(ms);
      const t = runtime.t;
      if (parts.hours > 0) {
        return parts.hours + ' ' + t('unit.hour') + ' ' + parts.minutes + ' ' + t('unit.minute');
      }
      if (parts.minutes > 0) {
        return parts.minutes + ' ' + t('unit.minute') + ' ' + parts.seconds + ' ' + t('unit.second');
      }
      return parts.seconds + ' ' + t('unit.second');
    }

    function sectionIcon(size) {
      return h(
        'svg',
        {
          viewBox: '0 0 64 64',
          width: size || 16,
          height: size || 16,
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', {
          cx: 32,
          cy: 28,
          r: 13,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 4,
        }),
        h('path', {
          d: 'M32 19.5v8.6l6 3.8',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 22, cy: 48.5, r: 3.2, fill: 'currentColor' }),
        h('circle', { cx: 32, cy: 48.5, r: 3.2, fill: 'currentColor', opacity: 0.6 }),
        h('circle', { cx: 42, cy: 48.5, r: 3.2, fill: 'currentColor', opacity: 0.32 })
      );
    }

    function createUi(runtime) {
      function SectionIcon(props) {
        const size = props && typeof props.size === 'number' ? props.size : 16;
        return sectionIcon(size);
      }

      function switchControl(tr, on, onToggle, label) {
        return h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'aria-label': label,
          'data-on': on ? 'true' : 'false',
          className: 'op-switch',
          onClick: function () {
            onToggle(!on);
          },
        }, h('span', { className: 'op-knob' }));
      }

      function rowSwitch(tr, on, onToggle, title, desc) {
        return h(
          'div',
          { className: 'op-row' },
          h(
            'div',
            { className: 'op-row-main' },
            h('span', { className: 'op-row-title' }, title),
            h('span', { className: 'op-row-desc' }, desc)
          ),
          switchControl(tr, on, onToggle, title)
        );
      }

      function choiceRow(tr, value, current, onSelect, title, desc) {
        const active = current === value;
        return h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': active ? 'true' : 'false',
            'data-active': active ? 'true' : 'false',
            className: 'op-choice',
            onClick: function () {
              onSelect(value);
            },
          },
          h(
            'span',
            { className: 'op-radio', 'aria-hidden': true },
            active ? h('span', { className: 'op-radio-dot' }) : null
          ),
          h(
            'span',
            { className: 'op-row-main' },
            h('span', { className: 'op-row-title' }, title),
            h('span', { className: 'op-row-desc' }, desc)
          )
        );
      }

      function field(label, input) {
        return h(
          'label',
          { className: 'op-field' },
          h('span', { className: 'op-field-label' }, label),
          input
        );
      }

      function selectControl(options, value, onChange) {
        return h(
          'span',
          { className: 'op-select-wrap' },
          h(
            'select',
            {
              className: 'op-input op-select',
              value: value,
              onChange: function (event) {
                onChange(event.target.value);
              },
            },
            options
          ),
          h('span', { className: 'op-select-caret', 'aria-hidden': true }, '▾')
        );
      }

      /** Keep the model inside the chosen provider, or fall back to "any". */
      function modelForProvider(providerId, modelId, providers) {
        if (!providerId || providerId === '*' || !modelId || modelId === '*') return '*';
        const provider = providers.filter(function (entry) {
          return entry.id === providerId;
        })[0];
        if (!provider) return modelId;
        const known = provider.models.some(function (model) {
          return model.id === modelId;
        });
        return known ? modelId : '*';
      }

      function providerSelect(tr, providerId, providers, onChange) {
        const options = [h('option', { value: '*', key: '*' }, tr('settings.anyProvider'))];
        for (const provider of providers) {
          options.push(h('option', { value: provider.id, key: provider.id }, provider.name));
        }
        if (
          providerId !== '*' &&
          !providers.some(function (provider) {
            return provider.id === providerId;
          })
        ) {
          options.push(h('option', { value: providerId, key: 'current' }, providerId));
        }
        return selectControl(options, providerId, onChange);
      }

      function modelSelect(tr, providerId, modelId, providers, onChange) {
        const options = [h('option', { value: '*', key: '*' }, tr('settings.anyModel'))];
        if (providerId === '*') {
          for (const provider of providers) {
            if (!provider.models.length) continue;
            options.push(
              h(
                'optgroup',
                { label: provider.name, key: provider.id },
                provider.models.map(function (model) {
                  return h('option', { value: model.id, key: provider.id + ':' + model.id }, model.name);
                })
              )
            );
          }
        } else {
          const provider = providers.filter(function (entry) {
            return entry.id === providerId;
          })[0];
          const models = provider ? provider.models : [];
          for (const model of models) {
            options.push(h('option', { value: model.id, key: model.id }, model.name));
          }
          if (
            modelId !== '*' &&
            !models.some(function (model) {
              return model.id === modelId;
            })
          ) {
            options.push(h('option', { value: modelId, key: 'current' }, modelId));
          }
        }
        return selectControl(options, modelId, onChange);
      }

      function clockInput(value, onChange) {
        return h('input', {
          type: 'text',
          className: 'op-input op-time',
          value: value,
          placeholder: '08:30',
          inputMode: 'numeric',
          spellCheck: false,
          maxLength: 5,
          onChange: function (event) {
            onChange(event.target.value);
          },
        });
      }

      function updateGroup(runtime, id, patch) {
        runtime.mutateConfig(function (config) {
          return Object.assign({}, config, {
            groups: config.groups.map(function (group) {
              return group.id === id ? Object.assign({}, group, patch) : group;
            }),
          });
        });
      }

      function SettingsSection() {
        const state = useSnapshot(runtime.store);
        const config = state.config;
        const tr = runtime.t;
        const groups = config.groups;
        const editPair = React.useState(null);
        const edit = editPair[0];
        const setEdit = editPair[1];
        const newYearPair = React.useState('');
        const newYear = newYearPair[0];
        const setNewYear = newYearPair[1];

        const calendar = runtime.calendarIndex();
        const years = Object.keys(calendar.years).sort().reverse();
        const todayKey = dateKeyOf(Date.now());
        const catalogState = state.catalog || { status: 'idle', providers: [], error: '' };
        const providers = catalogState.providers;

        React.useEffect(
          function () {
            runtime.ensureCatalog();
          },
          []
        );

        const catalogLine = (function () {
          if (catalogState.status === 'ready') {
            return h(
              'p',
              { className: 'op-hint' },
              tr('settings.catalogReady') + ' · ' + providers.length + ' ' + tr('settings.providerCount')
            );
          }
          if (catalogState.status === 'loading') {
            return h('p', { className: 'op-hint' }, tr('settings.catalogLoading'));
          }
          const failed = catalogState.status === 'error';
          return h(
            'p',
            { className: 'op-hint', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('span', null, failed ? tr('settings.catalogError') : tr('settings.catalogUnavailable')),
            h(
              'button',
              {
                type: 'button',
                className: 'op-link',
                onClick: function () {
                  runtime.ensureCatalog(true);
                },
              },
              tr('settings.catalogRetry')
            )
          );
        })();

        function saveYear(year, holidaysText, makeupsText) {
          runtime.mutateConfig(function (current) {
            const overrides = Object.assign({}, current.calendarOverrides);
            overrides[year] = { holidaysText: holidaysText, makeupsText: makeupsText, note: '' };
            return Object.assign({}, current, { calendarOverrides: overrides });
          });
          setEdit(null);
        }

        function resetYear(year) {
          runtime.mutateConfig(function (current) {
            const overrides = Object.assign({}, current.calendarOverrides);
            delete overrides[year];
            return Object.assign({}, current, { calendarOverrides: overrides });
          });
          setEdit(null);
        }

        const yearCards = years.map(function (year) {
          const entry = calendar.years[year];
          const holidayCount = Object.keys(entry.holidays).length;
          const makeupCount = Object.keys(entry.makeups).length;
          const official = entry.status === 'official';
          const editing = edit !== null && edit.year === year;
          const head = h(
            'div',
            { className: 'op-group-head' },
            h(
              'span',
              { className: 'op-row-title' },
              h('span', { className: 'op-year' }, year),
              ' · ',
              h('span', { className: 'op-row-desc' }, official ? tr('settings.official') : tr('settings.custom'))
            ),
            h(
              'span',
              { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h(
                'span',
                { className: 'op-row-desc' },
                holidayCount +
                  ' ' +
                  tr('settings.holidayDays') +
                  ' · ' +
                  makeupCount +
                  ' ' +
                  tr('settings.makeupDays')
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'op-link',
                  onClick: function () {
                    if (editing) {
                      setEdit(null);
                      return;
                    }
                    setEdit({
                      year: year,
                      holidaysText: formatDateLines(entry.holidays),
                      makeupsText: formatDateLines(entry.makeups, true),
                    });
                  },
                },
                editing ? tr('settings.cancel') : tr('settings.edit')
              ),
              !official
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'op-link op-link-danger',
                      onClick: function () {
                        resetYear(year);
                      },
                    },
                    tr('settings.reset')
                  )
                : null
            )
          );
          if (!editing) return h('div', { className: 'op-group', key: year }, head);
          return h(
            'div',
            { className: 'op-group', key: year },
            head,
            h(
              'div',
              { className: 'op-data-body' },
              h(
                'div',
                { className: 'op-field' },
                h('span', { className: 'op-field-label' }, tr('settings.holidayList')),
                h('textarea', {
                  className: 'op-textarea',
                  spellCheck: false,
                  value: edit.holidaysText,
                  placeholder: '2028-01-01 元旦',
                  onChange: function (event) {
                    setEdit({
                      year: year,
                      holidaysText: event.target.value,
                      makeupsText: edit.makeupsText,
                    });
                  },
                })
              ),
              h(
                'div',
                { className: 'op-field' },
                h('span', { className: 'op-field-label' }, tr('settings.makeupList')),
                h('textarea', {
                  className: 'op-textarea',
                  spellCheck: false,
                  value: edit.makeupsText,
                  placeholder: '2028-02-04',
                  onChange: function (event) {
                    setEdit({
                      year: year,
                      holidaysText: edit.holidaysText,
                      makeupsText: event.target.value,
                    });
                  },
                })
              ),
              h(
                'div',
                { className: 'op-data-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'op-btn',
                    onClick: function () {
                      setEdit(null);
                    },
                  },
                  tr('settings.cancel')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'op-btn op-btn-primary',
                    onClick: function () {
                      saveYear(year, edit.holidaysText, edit.makeupsText);
                    },
                  },
                  tr('settings.save')
                )
              )
            )
          );
        });

        const editingNewYear = edit !== null && years.indexOf(edit.year) === -1;
        const newYearCard = editingNewYear
          ? h(
              'div',
              { className: 'op-group', key: 'new-' + edit.year },
              h(
                'div',
                { className: 'op-group-head' },
                h(
                  'span',
                  { className: 'op-row-title' },
                  h('span', { className: 'op-year' }, edit.year),
                  ' · ',
                  h('span', { className: 'op-row-desc' }, tr('settings.custom'))
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'op-link',
                    onClick: function () {
                      setEdit(null);
                    },
                  },
                  tr('settings.cancel')
                )
              ),
              h(
                'div',
                { className: 'op-data-body' },
                h(
                  'div',
                  { className: 'op-field' },
                  h('span', { className: 'op-field-label' }, tr('settings.holidayList')),
                  h('textarea', {
                    className: 'op-textarea',
                    spellCheck: false,
                    value: edit.holidaysText,
                    placeholder: '2028-01-01 元旦',
                    onChange: function (event) {
                      setEdit({
                        year: edit.year,
                        holidaysText: event.target.value,
                        makeupsText: edit.makeupsText,
                      });
                    },
                  })
                ),
                h(
                  'div',
                  { className: 'op-field' },
                  h('span', { className: 'op-field-label' }, tr('settings.makeupList')),
                  h('textarea', {
                    className: 'op-textarea',
                    spellCheck: false,
                    value: edit.makeupsText,
                    placeholder: '2028-02-04',
                    onChange: function (event) {
                      setEdit({
                        year: edit.year,
                        holidaysText: edit.holidaysText,
                        makeupsText: event.target.value,
                      });
                    },
                  })
                ),
                h(
                  'div',
                  { className: 'op-data-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'op-btn',
                      onClick: function () {
                        setEdit(null);
                      },
                    },
                    tr('settings.cancel')
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'op-btn op-btn-primary',
                      onClick: function () {
                        saveYear(edit.year, edit.holidaysText, edit.makeupsText);
                      },
                    },
                    tr('settings.save')
                  )
                )
              )
            )
          : null;

        const groupCards = groups.map(function (group, index) {
          const todayInfo = describeDate(calendar, todayKey);
          const nowHit = peakWindow(Date.now(), group.windows, group.calendar, calendar);
          const hitToday = matchesCalendar(calendar, group.calendar, todayKey);
          const windows = group.windows.map(function (window, windowIndex) {
            return h(
              'div',
              { className: 'op-window', key: 'window-' + windowIndex },
              clockInput(window.start, function (value) {
                updateGroup(runtime, group.id, {
                  windows: group.windows.map(function (entry, entryIndex) {
                    return entryIndex === windowIndex ? Object.assign({}, entry, { start: value }) : entry;
                  }),
                });
              }),
              h('span', { className: 'op-arrow' }, '→'),
              clockInput(window.end, function (value) {
                updateGroup(runtime, group.id, {
                  windows: group.windows.map(function (entry, entryIndex) {
                    return entryIndex === windowIndex ? Object.assign({}, entry, { end: value }) : entry;
                  }),
                });
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'op-link op-link-danger',
                  onClick: function () {
                    updateGroup(runtime, group.id, {
                      windows: group.windows.filter(function (entry, entryIndex) {
                        return entryIndex !== windowIndex;
                      }),
                    });
                  },
                },
                tr('settings.removeWindow')
              )
            );
          });

          return h(
            'div',
            { className: 'op-group', key: group.id, 'data-on': group.enabled === false ? 'false' : 'true' },
            h(
              'div',
              { className: 'op-group-head' },
              h(
                'span',
                { className: 'op-row-title' },
                tr('settings.group').replace('{n}', String(index + 1))
              ),
              h(
                'span',
                { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                switchControl(
                  tr,
                  group.enabled !== false,
                  function (next) {
                    updateGroup(runtime, group.id, { enabled: next });
                  },
                  tr('settings.toggleGroup')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'op-link op-link-danger',
                    onClick: function () {
                      runtime.mutateConfig(function (current) {
                        return Object.assign({}, current, {
                          groups: current.groups.filter(function (entry) {
                            return entry.id !== group.id;
                          }),
                        });
                      });
                    },
                  },
                  tr('settings.removeGroup')
                )
              )
            ),
            h(
              'div',
              { className: 'op-group-body' },
              h(
                'div',
                { className: 'op-fields' },
                field(
                  tr('settings.provider'),
                  providerSelect(tr, group.provider, providers, function (next) {
                    updateGroup(runtime, group.id, {
                      provider: next,
                      model: modelForProvider(next, group.model, providers),
                    });
                  })
                ),
                field(
                  tr('settings.model'),
                  modelSelect(tr, group.provider, group.model, providers, function (next) {
                    updateGroup(runtime, group.id, { model: next });
                  })
                )
              ),
              h(
                'div',
                { className: 'op-field' },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
                  h('span', { className: 'op-field-label' }, tr('settings.calendar')),
                  h('span', { className: 'op-region' }, tr('region.' + group.region))
                ),
                h(
                  'div',
                  { className: 'op-chips', role: 'radiogroup', 'aria-label': tr('settings.calendar') },
                  CALENDAR_TYPES.map(function (type) {
                    const on = group.calendar === type;
                    return h(
                      'button',
                      {
                        type: 'button',
                        role: 'radio',
                        key: type,
                        className: 'op-chip',
                        'aria-checked': on ? 'true' : 'false',
                        'data-on': on ? 'true' : 'false',
                        onClick: function () {
                          updateGroup(runtime, group.id, { calendar: type });
                        },
                      },
                      tr('calendar.' + type)
                    );
                  })
                ),
                h('span', { className: 'op-hint' }, tr('calendar.hint.' + group.calendar)),
                h(
                  'span',
                  { className: 'op-hint' },
                  tr('settings.today') +
                    ' ' +
                    todayKey.slice(5) +
                    ' ' +
                    tr('weekday.' + todayInfo.weekdayKey) +
                    ' · ' +
                    tr('day.' + todayInfo.kind) +
                    '（' +
                    (hitToday ? tr('settings.todayMatch') : tr('settings.todayMiss')) +
                    '）' +
                    ' · ' +
                    tr('settings.nowLine') +
                    ' ' +
                    (nowHit
                      ? tr('settings.nowPeak') +
                        '（' +
                        String(nowHit.window.start) +
                        '–' +
                        String(nowHit.window.end) +
                        '）'
                      : tr('settings.nowOff'))
                )
              ),
              h(
                'div',
                { className: 'op-field' },
                h('span', { className: 'op-field-label' }, tr('settings.windows')),
                windows.length > 0 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, windows) : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'op-add',
                    onClick: function () {
                      updateGroup(runtime, group.id, {
                        windows: group.windows.concat([{ start: '08:00', end: '12:00' }]),
                      });
                    },
                  },
                  '+ ' + tr('settings.addWindow')
                )
              )
            )
          );
        });

        return h(
          'div',
          { className: 'op-sect' },
          h(
            'div',
            { className: 'op-head' },
            h('h3', { className: 'op-title' }, tr('settings.title')),
            h('p', { className: 'op-sub' }, tr('settings.intro'))
          ),
          h(
            'div',
            { className: 'op-card' },
            rowSwitch(
              tr,
              config.enabled,
              function (next) {
                runtime.patchConfig({ enabled: next });
              },
              tr('settings.enableTitle'),
              tr('settings.enableDesc')
            ),
            h(
              'div',
              { className: 'op-row' },
              h(
                'div',
                { className: 'op-row-main' },
                h('span', { className: 'op-row-title' }, tr('settings.statusTitle')),
                h(
                  'span',
                  { className: 'op-row-desc' },
                  runtime.interceptorState === 'installed'
                    ? tr('settings.statusInstalled')
                    : runtime.interceptorState === 'unavailable'
                      ? tr('settings.statusUnavailable')
                      : tr('settings.statusStopped')
                )
              ),
              h('span', {
                className: 'op-status-dot',
                'data-ok': runtime.interceptorState === 'installed' ? 'true' : 'false',
                'aria-hidden': true,
              })
            ),
            runtime.failures.length > 0
              ? h(
                  'div',
                  { className: 'op-row' },
                  h(
                    'div',
                    { className: 'op-row-main' },
                    h(
                      'span',
                      { className: 'op-row-title op-dock-error' },
                      tr('settings.statusFailures')
                    ),
                    h(
                      'span',
                      { className: 'op-row-desc' },
                      runtime.failures
                        .map(function (entry) {
                          return entry.step + ': ' + entry.message;
                        })
                        .join(' · ')
                    )
                  )
                )
              : null
          ),
          h(
            'div',
            { className: 'op-head' },
            h('h4', { className: 'op-title' }, tr('settings.strategyTitle')),
            h('p', { className: 'op-sub' }, tr('settings.strategyDesc'))
          ),
          h(
            'div',
            { className: 'op-card', role: 'radiogroup' },
            choiceRow(
              tr,
              'sequential',
              config.strategy,
              function (value) {
                runtime.patchConfig({ strategy: value });
              },
              tr('settings.strategySequential'),
              tr('settings.strategySequentialDesc')
            ),
            choiceRow(
              tr,
              'merge',
              config.strategy,
              function (value) {
                runtime.patchConfig({ strategy: value });
              },
              tr('settings.strategyMerge'),
              tr('settings.strategyMergeDesc')
            )
          ),
          h(
            'div',
            { className: 'op-head' },
            h('h4', { className: 'op-title' }, tr('settings.modelsTitle')),
            h('p', { className: 'op-sub' }, tr('settings.modelsDesc')),
            catalogLine,
            h(
              'button',
              {
                type: 'button',
                className: 'op-link',
                onClick: function () {
                  runtime.mutateConfig(function (current) {
                    const official = [
                      { start: '09:00', end: '12:00' },
                      { start: '14:00', end: '18:00' },
                    ];
                    if (current.groups.length === 0) {
                      return Object.assign({}, current, {
                        groups: [
                          {
                            id: uid('group'),
                            provider: '*',
                            model: '*',
                            enabled: true,
                            region: 'cn',
                            calendar: 'legalWorkday',
                            windows: official,
                          },
                        ],
                      });
                    }
                    return Object.assign({}, current, {
                      groups: current.groups.map(function (group, groupIndex) {
                        if (groupIndex !== 0) return group;
                        return Object.assign({}, group, {
                          calendar: 'legalWorkday',
                          windows: official,
                        });
                      }),
                    });
                  });
                },
              },
              tr('settings.applyOfficial')
            )
          ),
          h(
            'div',
            { className: 'op-group-list' },
            groups.length > 0 ? groupCards : h('p', { className: 'op-sub' }, tr('settings.emptyGroups')),
            h(
              'button',
              {
                type: 'button',
                className: 'op-add',
                onClick: function () {
                  runtime.mutateConfig(function (current) {
                    return Object.assign({}, current, {
                      groups: current.groups.concat([
                        {
                          id: uid('group'),
                          provider: '*',
                          model: '*',
                          enabled: true,
                          region: 'cn',
                          calendar: 'legalWorkday',
                          windows: [
                            { start: '08:00', end: '12:00' },
                            { start: '14:00', end: '18:00' },
                          ],
                        },
                      ]),
                    });
                  });
                },
              },
              '+ ' + tr('settings.addModel')
            )
          ),
          h(
            'div',
            { className: 'op-head' },
            h('h4', { className: 'op-title' }, tr('settings.dataTitle')),
            h('p', { className: 'op-sub' }, tr('settings.dataDesc'))
          ),
          h(
            'div',
            { className: 'op-group-list' },
            yearCards,
            newYearCard,
            h(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h('input', {
                className: 'op-input op-time',
                value: newYear,
                placeholder: '2028',
                inputMode: 'numeric',
                maxLength: 4,
                spellCheck: false,
                onChange: function (event) {
                  setNewYear(event.target.value.replace(/[^0-9]/g, '').slice(0, 4));
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'op-add',
                  style: { width: 'auto', padding: '0 14px' },
                  onClick: function () {
                    if (!/^\d{4}$/.test(newYear)) return;
                    setEdit({ year: newYear, holidaysText: '', makeupsText: '' });
                    setNewYear('');
                  },
                },
                '+ ' + tr('settings.addYear')
              )
            )
          ),
          h('p', { className: 'op-hint' }, tr('settings.timeHint'))
        );
      }

      function SendGuardModal() {
        const state = useSnapshot(runtime.store);
        const confirm = state.confirms.length > 0 ? state.confirms[0] : null;
        if (!confirm) return null;
        return h(ConfirmSurface, { confirm: confirm, key: confirm.id });
      }

      function ConfirmSurface(props) {
        const confirm = props.confirm;
        const now = useSnapshot(runtime.clock);
        const confirmId = confirm.id;

        React.useEffect(
          function () {
            function onKeyDown(event) {
              if (event.key === 'Escape') {
                event.preventDefault();
                runtime.resolveConfirm(confirmId, 'cancel');
              }
            }
            window.addEventListener('keydown', onKeyDown);
            return function () {
              window.removeEventListener('keydown', onKeyDown);
            };
          },
          [confirmId]
        );

        const tr = runtime.t;
        const remaining = Math.max(0, confirm.endsAt - now);
        const modelLabel = confirm.modelLabel || tr('modal.unknownModel');
        const preview = (confirm.text || '').trim();

        const surface = h(
          'div',
          { className: 'op-overlay' },
          h('div', { className: 'op-mask' }),
          h(
            'div',
            {
              className: 'op-modal',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': 'op-modal-title',
            },
            h(
              'div',
              { className: 'op-modal-head' },
              h('span', { className: 'op-modal-icon' }, sectionIcon(18)),
              h(
                'span',
                { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: '1 1 auto' } },
                h('h2', { className: 'op-modal-title', id: 'op-modal-title' }, tr('modal.title')),
                h('span', { className: 'op-modal-desc' }, tr('modal.body'))
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'op-modal-close',
                  'aria-label': tr('modal.cancel'),
                  onClick: function () {
                    runtime.resolveConfirm(confirm.id, 'cancel');
                  },
                },
                '×'
              )
            ),
            h(
              'div',
              { className: 'op-modal-desc' },
              modelLabel +
                ' · ' +
                tr('calendar.' + confirm.calendar) +
                (confirm.anchorDate ? ' ' + confirm.anchorDate : '') +
                (confirm.windowLabel ? ' · ' + confirm.windowLabel : '')
            ),
            h(
              'div',
              { className: 'op-modal-count' },
              tr('modal.countdown') + ' ' + humanDuration(runtime, remaining)
            ),
            preview !== ''
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                  h('span', { className: 'op-field-label' }, tr('modal.preview')),
                  h(
                    'div',
                    { className: 'op-quote', title: preview },
                    preview.length > 400 ? preview.slice(0, 400) + '…' : preview
                  )
                )
              : null,
            h(
              'div',
              { className: 'op-modal-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'op-btn',
                  onClick: function () {
                    runtime.resolveConfirm(confirm.id, 'cancel');
                  },
                },
                tr('modal.cancel')
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'op-btn op-btn-secondary',
                  onClick: function () {
                    runtime.resolveConfirm(confirm.id, 'later');
                  },
                },
                tr('modal.later')
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'op-btn op-btn-primary',
                  autoFocus: true,
                  onClick: function () {
                    runtime.resolveConfirm(confirm.id, 'now');
                  },
                },
                tr('modal.now')
              )
            )
          )
        );

        if (typeof document === 'undefined') return surface;
        try {
          const ReactDom = require('react-dom');
          if (ReactDom && typeof ReactDom.createPortal === 'function') {
            return ReactDom.createPortal(surface, document.body);
          }
        } catch (error) {
          /* fall back to in-place rendering inside the overlay slot */
        }
        return surface;
      }

      function QueueDock(props) {
        const useSession = props && typeof props.useSession === 'function' ? props.useSession : null;
        const selectedId = useSession
          ? useSession(function (snapshot) {
              return snapshot ? snapshot.sessionId : undefined;
            })
          : undefined;
        const sessionId = (props && props.sessionId) || selectedId;
        const state = useSnapshot(runtime.store);
        const items = sessionId && state.queues[sessionId] ? state.queues[sessionId] : [];
        if (!items || items.length === 0) return null;
        return h(QueueSurface, { sessionId: sessionId, items: items, key: sessionId });
      }

      function QueueSurface(props) {
        const sessionId = props.sessionId;
        const items = props.items;
        const now = useSnapshot(runtime.clock);
        const expandedPair = React.useState(false);
        const expanded = items.length === 1 ? true : expandedPair[0];
        const setExpanded = expandedPair[1];

        const tr = runtime.t;
        let waitAt = 0;
        for (const item of items) {
          const at = runtime.readyAt(item, now);
          if (at === 0) continue;
          waitAt = waitAt === 0 ? at : Math.min(waitAt, at);
        }

        const rows = items.map(function (item) {
          const at = runtime.readyAt(item, now);
          const hasError = item.error !== '';
          const exhausted = hasError && (item.attempts || 0) >= MAX_ATTEMPTS;
          const attachments = item.attachments && item.attachments.length > 0;
          const note = hasError
            ? tr('dock.failed') + (exhausted ? ' · ' + tr('dock.stopped') : '')
            : at === 0
              ? tr('dock.ready')
              : tr('dock.waiting') + ' ' + humanDuration(runtime, at - now);
          return h(
            'li',
            { className: 'op-dock-row', key: item.id },
            h(
              'span',
              { className: 'op-dock-text', title: item.text },
              (item.text || '').trim().slice(0, 240) || '…'
            ),
            attachments
              ? h('span', { className: 'op-dock-note' }, item.attachments.length + ' ' + tr('dock.attachments'))
              : null,
            h('span', { className: 'op-dock-note' + (hasError ? ' op-dock-error' : '') }, note),
            hasError
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'op-dock-action',
                    onClick: function () {
                      runtime.clearItemError(sessionId, item.id);
                      runtime.pump();
                    },
                  },
                  tr('dock.retry')
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'op-dock-action',
                onClick: function () {
                  runtime.removeItems(sessionId, [item.id]);
                },
              },
              tr('dock.remove')
            )
          );
        });

        const headerText =
          tr('dock.title') +
          ' · ' +
          items.length +
          ' ' +
          tr('dock.count') +
          (waitAt > 0 ? ' · ' + humanDuration(runtime, waitAt - now) : ' · ' + tr('dock.ready'));

        return h(
          'div',
          { className: 'op-dock' },
          h(
            'div',
            { className: 'op-dock-panel' },
            h(
              'button',
              {
                type: 'button',
                className: 'op-dock-head',
                'aria-expanded': expanded ? 'true' : 'false',
                onClick: function () {
                  setExpanded(!expanded);
                },
              },
              h('span', { className: 'op-dock-lead', 'aria-hidden': true }, sectionIcon(14)),
              h('span', { className: 'op-dock-count' }, headerText),
              h('span', { className: 'op-dock-chevron', 'aria-hidden': true }, expanded ? '▾' : '▸')
            ),
            expanded ? h('ul', { className: 'op-dock-list' }, rows) : null,
            expanded
              ? h(
                  'div',
                  { className: 'op-dock-foot' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'op-dock-action',
                      onClick: function () {
                        runtime.clearQueue(sessionId);
                      },
                    },
                    tr('dock.clear')
                  )
                )
              : null
          )
        );
      }

      return {
        SettingsSection: SettingsSection,
        SectionIcon: SectionIcon,
        SendGuardModal: SendGuardModal,
        QueueDock: QueueDock,
      };
    }

    /* ------------------------------------------------------------------ *
     * Plugin                                                           *
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      try {
        applyInner(ctx);
      } catch (error) {
        // Last-resort guard: plugin activation must never fail the whole page.
        try {
          if (plugin.__runtime) plugin.__runtime.recordFailure('apply', error);
        } catch (inner) {}
      }
    }

    function applyInner(ctx) {
      const runtime = createRuntime(ctx);
      const ui = createUi(runtime);
      plugin.__runtime = runtime;
      const disposers = [];

      /** Register one slot entry; a slot failure must never abort activation. */
      function registerSlot(slot, options, component) {
        try {
          if (!ctx.slots || typeof ctx.slots.inject !== 'function') {
            runtime.recordFailure('slots', new Error('slot service unavailable'));
            return;
          }
          ctx.slots.inject(slot, function () {
            try {
              return ctx.slots.register(options, component);
            } catch (error) {
              runtime.recordFailure('register:' + slot, error);
              return function () {};
            }
          });
        } catch (error) {
          runtime.recordFailure('slot:' + slot, error);
        }
      }

      /** Run one optional capability; failures stay local and visible in Settings. */
      function isolate(step, run) {
        try {
          const dispose = run();
          if (typeof dispose === 'function') disposers.push(dispose);
        } catch (error) {
          runtime.recordFailure(step, error);
        }
      }

      // 1. UI first: even when every later step fails, the settings page and the
      //    queue dock still mount and can explain what went wrong.
      registerSlot(
        'settings.section',
        {
          name: 'settings.section',
          id: 'offpeak-send',
          order: 120,
          label: function () {
            return runtime.t('settings.nav');
          },
        },
        ui.SettingsSection
      );
      registerSlot(
        'settings.section.icon',
        {
          name: 'settings.section.icon',
          id: 'offpeak-send',
          inline: true,
        },
        ui.SectionIcon
      );
      registerSlot(
        'conversation.input.dock',
        {
          name: 'conversation.input.dock',
          id: 'offpeak-queue',
          order: 40,
        },
        ui.QueueDock
      );
      registerSlot(
        'shell.overlay',
        {
          name: 'shell.overlay',
          id: 'offpeak-modal',
          order: 900,
        },
        ui.SendGuardModal
      );

      // 2. Optional pieces, each isolated.
      isolate('styles', installStyles);
      isolate('locale', runtime.installLocale);
      isolate('interceptor', runtime.installInterceptor);
      isolate('clock', runtime.startClock);
      isolate('catalog-reset', function () {
        if (typeof ctx.on !== 'function') return function () {};
        return ctx.effect(function () {
          return ctx.on('connection/reset', function () {
            try {
              runtime.ensureCatalog(true);
            } catch (error) {
              runtime.recordFailure('catalog', error);
            }
          });
        }, 'offpeak-sender: catalog reset');
      });

      try {
        ctx.effect(
          function () {
            return function () {
              try {
                runtime.teardown();
              } catch (error) {}
              for (const dispose of disposers) {
                try {
                  dispose();
                } catch (error) {}
              }
            };
          },
          'offpeak-sender: teardown'
        );
      } catch (error) {
        runtime.recordFailure('teardown', error);
      }
    }

    const plugin = {
      inject: ['slots', 'conversation', 'remote.session'],
      apply: apply,
      __pure: Pure,
      __dicts: DICTS,
      __runtime: null,
    };
    return plugin;
  },
});
