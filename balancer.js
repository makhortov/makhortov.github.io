/**
 * ПЛАГИН "Balancer" ДЛЯ LAMPA — адаптирован под backend
 * ============================================================================
 * "Балансеры" — это ПРОВАЙДЕРЫ внутри ОДНОГО ответа API (provider1/provider2/provider3/...).
 * Бэкенд один (BACKEND_URL), один запрос /api/get возвращает сразу всё.
 *
 * ФОРМАТ ОТВЕТА (подтверждено практикой):
 *   Фильм:  { "providers": { "provider": [ {title,url,mime,subtitles,...}, ... ] } }
 *   Сериал: { "providers": { "provider": {
 *               "1": { "1": [ {...} ], "2": [ {...} ], ... },   // сезон -> серия -> варианты
 *               "2": { ... }
 *             } } }
 *   У разных провайдеров разный набор сезонов/серий — это учитывается:
 *   список сезонов/озвучек пересчитывается при каждом переключении балансера.
 *
 * Помимо запроса к бэкенду и переключения провайдеров, плагин повторяет
 * стандартный UX онлайн-плагинов Lampa: прогресс просмотра (таймлайн),
 * отметки "просмотрено", добавление в историю, автопродолжение на
 * следующую серию и контекстное меню по долгому нажатию.
 * ============================================================================
 */
(function () {
    'use strict';

    /**
     * ========================================================================
     * 1. АДРЕС БЭКЕНДА
     * ========================================================================
     */
    var BACKEND_URL = 'http://makhortov.duckdns.org:8088';

    /**
     * ========================================================================
     * 2. КОНСТАНТЫ ПЛАГИНА
     * ========================================================================
     */
    var PROVIDER_STORAGE_KEY = 'balancer_plugin_selected_provider';
    var VIEWED_STORAGE_KEY = 'online_view';
    var COMPONENT_NAME = 'balancer_source_component';
    var PLUGIN_TITLE = 'Balancer';
    var ITEM_TEMPLATE_NAME = 'balancer_item';
    var QUALITY_ORDER = ['2160p', '1440p', '1080p Ultra', '1080p', '720p', '480p', '360p', '240p'];

    /**
     * ========================================================================
     * 3. ЗАПРОС К БЭКЕНДУ
     * ========================================================================
     */
    function detectContentType(movie) {
        return movie && movie.name ? 'tv' : 'movie';
    }

    function buildRequestUrl(movie) {
        var tmdbId = movie && movie.id;
        var type = detectContentType(movie);
        return BACKEND_URL + '/api/get?id=' + encodeURIComponent(tmdbId) + '&type=' + encodeURIComponent(type);
    }

    function requestBackendData(movie, onSuccess, onError) {
        var network = new Lampa.Reguest();
        var url = buildRequestUrl(movie);
        var settled = false;

        var watchdog = setTimeout(function () {
            if (settled) return;
            settled = true;
            onError(new Error('Timeout waiting for backend response'));
        }, 20000);

        network.timeout(15000);

        network.silent(
            url,
            function (data) {
                if (settled) return;
                settled = true;
                clearTimeout(watchdog);

                var normalized = normalizeBackendResponse(data);
                if (normalized) onSuccess(normalized);
                else onError(new Error('Empty response'));
            },
            function (error) {
                if (settled) return;
                settled = true;
                clearTimeout(watchdog);
                onError(error);
            }
        );

        return network;
    }

    /**
     * ========================================================================
     * 4. ПЕРЕВОД ОТВЕТА БЭКЕНДА В УДОБНЫЙ ВИД
     * ========================================================================
     */
    function isPlainObject(val) {
        return val && typeof val === 'object' && !Array.isArray(val);
    }

    // Приводит один элемент источника к единому виду.
    function mapProviderItem(item) {
        return {
            title: item.title || 'Original',
            quality: item.quality || 'Auto',
            url: item.url,
            subtitles: item.subtitles || []
        };
    }

    // Фильм: providers[name] — плоский массив вариантов.
    function mapMovieProvidersObject(providers) {
        var result = {};

        Object.keys(providers || {}).forEach(function (name) {
            result[name] = (providers[name] || [])
                .filter(function (item) {
                    return item && item.url;
                })
                .map(mapProviderItem);
        });

        return result;
    }

    // Сериал: providers[name] — { сезон: { серия: [варианты] } }.
    function mapSeriesProviderData(seasonsObj) {
        var seasons = {};

        Object.keys(seasonsObj || {}).forEach(function (seasonKey) {
            var episodesObj = seasonsObj[seasonKey] || {};
            var episodes = {};

            Object.keys(episodesObj).forEach(function (episodeKey) {
                episodes[episodeKey] = (episodesObj[episodeKey] || [])
                    .filter(function (item) {
                        return item && item.url;
                    })
                    .map(mapProviderItem);
            });

            seasons[seasonKey] = episodes;
        });

        return seasons;
    }

    function normalizeBackendResponse(data) {
        if (!data || !data.providers) return null;

        var providerNames = Object.keys(data.providers);
        if (!providerNames.length) return null;

        // Тип определяем по фактической форме данных: если значение хотя бы
        // одного провайдера — не массив, значит это структура сериала
        // (сезон -> серия -> варианты), а не плоский список вариантов фильма.
        var isSeries = providerNames.some(function (name) {
            return isPlainObject(data.providers[name]);
        });

        if (isSeries) {
            var mappedSeries = {};
            providerNames.forEach(function (name) {
                mappedSeries[name] = mapSeriesProviderData(data.providers[name]);
            });
            return { type: 'series', providers: mappedSeries };
        }

        return { type: 'movie', providers: mapMovieProvidersObject(data.providers) };
    }

    /**
     * ========================================================================
     * 5. СОХРАНЕНИЕ ВЫБРАННОГО ПРОВАЙДЕРА
     * ========================================================================
     */
    function saveSelectedProvider(name) {
        Lampa.Storage.set(PROVIDER_STORAGE_KEY, name);
    }

    function getSavedProvider() {
        return Lampa.Storage.get(PROVIDER_STORAGE_KEY, '');
    }

    /**
     * ========================================================================
     * 6. ШАБЛОН ЭЛЕМЕНТА СПИСКА (как в online_mod)
     * ========================================================================
     */
    function registerItemTemplate() {
        Lampa.Template.add(
            ITEM_TEMPLATE_NAME,
            '<div class="online selector">' +
            '<div class="online__body">' +
            '<div style="position: absolute;left: 0;top: -0.3em;width: 2.4em;height: 2.4em">' +
            '<svg style="height: 2.4em; width: 2.4em;" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<circle cx="64" cy="64" r="56" stroke="white" stroke-width="16"/>' +
            '<path d="M90.5 64.3827L50 87.7654L50 41L90.5 64.3827Z" fill="white"/>' +
            '</svg>' +
            '</div>' +
            '<div class="online__title" style="padding-left: 2.1em;">{title}</div>' +
            '<div class="online__quality" style="padding-left: 3.4em;">{quality}{info}</div>' +
            '</div>' +
            '</div>'
        );
    }

    /**
     * ========================================================================
     * 7. ХЭШИ ДЛЯ ТАЙМЛАЙНА И ОТМЕТОК "ПРОСМОТРЕНО"
     * ========================================================================
     * Схема хэшей повторяет online_mod, чтобы прогресс просмотра/отметки
     * не терялись и совпадали по смыслу с другими онлайн-плагинами.
     */
    function movieHashTitle(movie) {
        return movie.original_title || movie.original_name || movie.title || movie.name || '';
    }

    function timelineHash(movie, seasonKey, episodeKey) {
        var title = movieHashTitle(movie);

        if (seasonKey != null && episodeKey != null) {
            return Lampa.Utils.hash([seasonKey, parseInt(seasonKey, 10) > 10 ? ':' : '', episodeKey, title].join(''));
        }

        return Lampa.Utils.hash(title);
    }

    function viewedHash(movie, seasonKey, episodeKey, voice) {
        var title = movieHashTitle(movie);

        if (seasonKey != null && episodeKey != null) {
            return Lampa.Utils.hash([seasonKey, parseInt(seasonKey, 10) > 10 ? ':' : '', episodeKey, title, voice || ''].join(''));
        }

        return Lampa.Utils.hash(title + (voice || ''));
    }

    /**
     * ========================================================================
     * 8. ВЫБОР КАЧЕСТВА И ГРУППИРОВКА ВАРИАНТОВ
     * ========================================================================
     * Варианты с одинаковым title (одна озвучка/перевод) объединяются в одну
     * строку списка с картой качеств {label: url}, чтобы плеер Lampa мог
     * показать переключатель качества и подставить качество по умолчанию.
     */
    function resolvePreferredUrl(qualitys, fallbackUrl) {
        if (!qualitys) return fallbackUrl;

        var keys = Object.keys(qualitys);
        if (!keys.length) return fallbackUrl;

        var preferred = Lampa.Storage.get('video_quality_default', '1080') + 'p';
        if (preferred === '1080p') preferred = '1080p Ultra';

        var idx = QUALITY_ORDER.indexOf(preferred);
        if (idx === -1) idx = QUALITY_ORDER.indexOf('1080p');

        for (var i = idx; i < QUALITY_ORDER.length; i++) {
            if (qualitys[QUALITY_ORDER[i]]) return qualitys[QUALITY_ORDER[i]];
        }

        for (var j = idx - 1; j >= 0; j--) {
            if (qualitys[QUALITY_ORDER[j]]) return qualitys[QUALITY_ORDER[j]];
        }

        return qualitys[keys[0]] || fallbackUrl;
    }

    function renameQualityMap(qualitys) {
        if (!qualitys) return qualitys;

        var renamed = {};
        Object.keys(qualitys).forEach(function (label) {
            renamed['​' + label] = qualitys[label];
        });

        return renamed;
    }

    function buildVariantGroup(items) {
        var qualitys = {};
        var subtitles = [];

        items.forEach(function (item) {
            var label = item.quality || 'Auto';
            if (!qualitys[label]) qualitys[label] = item.url;
            (item.subtitles || []).forEach(function (sub) {
                subtitles.push(sub);
            });
        });

        return {
            qualitys: qualitys,
            url: items[0].url,
            subtitles: subtitles.length ? subtitles : false
        };
    }

    // Фильм: группируем плоский список по title (озвучка/перевод).
    function groupMovieVariants(items) {
        var order = [];
        var buckets = {};

        (items || []).forEach(function (item) {
            var key = item.title || 'Original';
            if (!buckets[key]) {
                buckets[key] = [];
                order.push(key);
            }
            buckets[key].push(item);
        });

        return order.map(function (key) {
            var group = buildVariantGroup(buckets[key]);
            group.title = key;
            return group;
        });
    }

    // Сериал: среди вариантов серии находим все совпадающие с выбранной озвучкой.
    function groupEpisodeVariant(items, voiceTitle) {
        var matched = (items || []).filter(function (item) {
            return item.title === voiceTitle;
        });

        if (!matched.length) return null;

        var group = buildVariantGroup(matched);
        group.title = voiceTitle;
        return group;
    }

    /**
     * ========================================================================
     * 9. ВОСПРОИЗВЕДЕНИЕ
     * ========================================================================
     */
    function buildPlaylistEntry(movie, row) {
        return {
            url: resolvePreferredUrl(row.group.qualitys, row.group.url),
            quality: renameQualityMap(row.group.qualitys),
            subtitles: row.group.subtitles,
            timeline: row.timeline,
            title: row.seasonKey != null ? row.title : (movie.title || movie.name || row.title)
        };
    }

    function markViewed(row, viewed, item) {
        if (viewed.indexOf(row.viewedHash) === -1) {
            viewed.push(row.viewedHash);
            item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
            Lampa.Storage.set(VIEWED_STORAGE_KEY, viewed);
        }
    }

    function playRow(movie, row, allRows, isSeries, viewed, item) {
        if (!row.group || !row.group.url) {
            Lampa.Noty.show('У выбранного варианта нет ссылки на видео.');
            return;
        }

        if (movie.id) Lampa.Favorite.add('history', movie, 100);

        var first = buildPlaylistEntry(movie, row);
        Lampa.Player.play(first);

        if (isSeries) {
            Lampa.Player.playlist(allRows.map(function (r) {
                return r === row ? first : buildPlaylistEntry(movie, r);
            }));
        } else {
            Lampa.Player.playlist([first]);
        }

        markViewed(row, viewed, item);
    }

    /**
     * ========================================================================
     * 10. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ РАБОТЫ С СЕЗОНАМИ/СЕРИЯМИ/ОЗВУЧКАМИ
     * ========================================================================
     */
    function sortedNumericKeys(obj) {
        return Object.keys(obj || {}).sort(function (a, b) {
            return parseInt(a, 10) - parseInt(b, 10);
        });
    }

    // Уникальные названия озвучек (item.title), встречающиеся в сезоне —
    // хотя бы в одной серии. Пример значения: "1+1", "Original".
    function collectVoiceNames(seasonObj) {
        var names = [];

        Object.keys(seasonObj || {}).forEach(function (episodeKey) {
            (seasonObj[episodeKey] || []).forEach(function (item) {
                if (item.title && names.indexOf(item.title) === -1) names.push(item.title);
            });
        });

        return names;
    }

    /**
     * ========================================================================
     * 11. КОМПОНЕНТ ИСТОЧНИКА — на базе Lampa.Explorer/Filter/Scroll
     * ========================================================================
     */
    function BalancerComponent(object) {
        registerItemTemplate();

        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var files = new Lampa.Explorer(object);
        var filter = new Lampa.Filter(object);

        var normalizedData = null;
        var availableProviders = [];
        var selectedProvider = '';
        var selectedSeasonKey = '';
        var selectedVoice = '';
        var last = null;
        var self = this;

        scroll.body().addClass('torrent-list');
        scroll.minus(files.render().find('.explorer__files-head'));

        function collectAvailableProviders() {
            var names = [];

            if (normalizedData.type === 'movie') {
                Object.keys(normalizedData.providers).forEach(function (name) {
                    if (normalizedData.providers[name].length) names.push(name);
                });
            } else {
                Object.keys(normalizedData.providers).forEach(function (name) {
                    if (Object.keys(normalizedData.providers[name]).length) names.push(name);
                });
            }

            return names;
        }

        function pickInitialProvider() {
            var saved = getSavedProvider();
            if (saved && availableProviders.indexOf(saved) !== -1) return saved;
            return availableProviders[0] || '';
        }

        // Пересчитывает сезон/озвучку под ТЕКУЩИЙ провайдер (у разных
        // провайдеров разный набор сезонов). Вызывается при смене провайдера.
        function resetSeasonAndVoiceForProvider() {
            if (normalizedData.type !== 'series') return;

            var seasons = normalizedData.providers[selectedProvider] || {};
            var seasonKeys = sortedNumericKeys(seasons);
            selectedSeasonKey = seasonKeys[0] || '';

            resetVoiceForSeason();
        }

        function resetVoiceForSeason() {
            if (normalizedData.type !== 'series') return;

            var seasons = normalizedData.providers[selectedProvider] || {};
            var season = seasons[selectedSeasonKey] || {};
            var voices = collectVoiceNames(season);

            selectedVoice = voices[0] || '';
        }

        function applyFilterUI() {
            var select = [];

            if (normalizedData.type === 'series') {
                var seasons = normalizedData.providers[selectedProvider] || {};
                var seasonKeys = sortedNumericKeys(seasons);
                var seasonNames = seasonKeys.map(function (key) {
                    return 'Сезон ' + key;
                });

                select.push({ title: 'Сбросить', reset: true });

                if (seasonKeys.length) {
                    var seasonIndex = seasonKeys.indexOf(selectedSeasonKey);
                    var seasonItems = seasonKeys.map(function (key, i) {
                        return { title: 'Сезон ' + key, selected: i === seasonIndex, index: i, key: key };
                    });
                    select.push({
                        title: 'Сезон',
                        subtitle: 'Сезон ' + selectedSeasonKey,
                        items: seasonItems,
                        stype: 'season'
                    });

                    var season = seasons[selectedSeasonKey] || {};
                    var voices = collectVoiceNames(season);

                    if (voices.length) {
                        var voiceIndex = voices.indexOf(selectedVoice);
                        var voiceItems = voices.map(function (name, i) {
                            return { title: name, selected: i === voiceIndex, index: i };
                        });
                        select.push({
                            title: 'Озвучка',
                            subtitle: selectedVoice,
                            items: voiceItems,
                            stype: 'voice'
                        });
                    }
                }
            } else {
                select.push({ title: 'Сбросить', reset: true });
            }

            filter.set('filter', select);

            // "Балансер" = переключатель провайдера (provider1/provide2/provider3/...).
            filter.render().find('.filter--sort span').text('Балансер');
            filter.set(
                'sort',
                availableProviders.map(function (name) {
                    return {
                        title: name,
                        provider: name,
                        selected: name === selectedProvider
                    };
                })
            );

            var chosen = [];
            if (normalizedData.type === 'series') {
                if (selectedSeasonKey) chosen.push('Сезон ' + selectedSeasonKey);
                if (selectedVoice) chosen.push(selectedVoice);
            }
            filter.chosen('filter', chosen);
            filter.chosen('sort', [selectedProvider || '—']);
        }

        function currentResults() {
            if (!normalizedData || !selectedProvider) return [];

            if (normalizedData.type === 'series') {
                var seasons = normalizedData.providers[selectedProvider] || {};
                var season = seasons[selectedSeasonKey] || {};
                var episodeKeys = sortedNumericKeys(season);

                var rows = [];
                episodeKeys.forEach(function (episodeKey) {
                    var group = groupEpisodeVariant(season[episodeKey], selectedVoice);
                    if (!group) return;

                    rows.push({
                        title: 'Серия ' + episodeKey,
                        quality: Object.keys(group.qualitys).join(' / ') || 'Auto',
                        info: group.subtitles ? ' / CC' : '',
                        seasonKey: selectedSeasonKey,
                        episodeKey: episodeKey,
                        voice: selectedVoice,
                        group: group
                    });
                });
                return rows;
            }

            return groupMovieVariants(normalizedData.providers[selectedProvider]).map(function (group) {
                return {
                    title: group.title,
                    quality: Object.keys(group.qualitys).join(' / ') || 'Auto',
                    info: group.subtitles ? ' / CC' : '',
                    seasonKey: null,
                    episodeKey: null,
                    voice: group.title,
                    group: group
                };
            });
        }

        function attachContextMenu(item, row, viewed, contextRows) {
            item.on('hover:long', function () {
                var enabled = Lampa.Controller.enabled().name;

                var menu = [
                    { title: Lampa.Lang.translate('torrent_parser_label_title'), mark: true },
                    { title: Lampa.Lang.translate('torrent_parser_label_cancel_title'), clearmark: true },
                    { title: 'Снять отметку у всех', clearmark_all: true },
                    { title: Lampa.Lang.translate('time_reset'), timeclear: true },
                    { title: 'Сбросить тайм-код у всех', timeclear_all: true }
                ];

                if (Lampa.Platform.is('android')) {
                    menu.push({ title: Lampa.Lang.translate('player_lauch') + ' - Android', player: 'android' });
                }
                if (Lampa.Platform.is('webos')) {
                    menu.push({ title: Lampa.Lang.translate('player_lauch') + ' - Webos', player: 'webos' });
                }
                menu.push({ title: Lampa.Lang.translate('player_lauch') + ' - Lampa', player: 'lampa' });
                menu.push({ title: Lampa.Lang.translate('copy_link'), copylink: true });

                Lampa.Select.show({
                    title: Lampa.Lang.translate('title_action'),
                    items: menu,
                    onBack: function () {
                        Lampa.Controller.toggle(enabled);
                    },
                    onSelect: function (a) {
                        if (a.mark) markViewed(row, viewed, item);

                        if (a.clearmark) {
                            Lampa.Arrays.remove(viewed, row.viewedHash);
                            Lampa.Storage.set(VIEWED_STORAGE_KEY, viewed);
                            item.find('.torrent-item__viewed').remove();
                        }

                        if (a.clearmark_all) {
                            contextRows.forEach(function (ctx) {
                                Lampa.Arrays.remove(ctx.viewed, ctx.row.viewedHash);
                                ctx.item.find('.torrent-item__viewed').remove();
                            });
                            Lampa.Storage.set(VIEWED_STORAGE_KEY, viewed);
                        }

                        if (a.timeclear) {
                            row.timeline.percent = 0;
                            row.timeline.time = 0;
                            row.timeline.duration = 0;
                            Lampa.Timeline.update(row.timeline);
                        }

                        if (a.timeclear_all) {
                            contextRows.forEach(function (ctx) {
                                ctx.row.timeline.percent = 0;
                                ctx.row.timeline.time = 0;
                                ctx.row.timeline.duration = 0;
                                Lampa.Timeline.update(ctx.row.timeline);
                            });
                        }

                        Lampa.Controller.toggle(enabled);

                        if (a.player) {
                            Lampa.Player.runas(a.player);
                            item.trigger('hover:enter');
                        }

                        if (a.copylink) {
                            var url = resolvePreferredUrl(row.group.qualitys, row.group.url);
                            Lampa.Utils.copyTextToClipboard(url, function () {
                                Lampa.Noty.show(Lampa.Lang.translate('copy_secuses'));
                            }, function () {
                                Lampa.Noty.show(Lampa.Lang.translate('copy_error'));
                            });
                        }
                    }
                });
            }).on('hover:focus', function () {
                if (Lampa.Helper) Lampa.Helper.show('online_file', 'Удерживайте клавишу "ОК" для вызова контекстного меню', item);
            });
        }

        function renderList() {
            scroll.render().find('.empty').remove();
            scroll.clear();

            var results = currentResults();

            if (!results.length) {
                showEmptyState('Провайдер не вернул вариантов воспроизведения');
                return;
            }

            var isSeries = normalizedData.type === 'series';
            var viewed = Lampa.Storage.cache(VIEWED_STORAGE_KEY, 5000, []);
            var contextRows = [];

            results.forEach(function (row) {
                row.timeline = Lampa.Timeline.view(timelineHash(object.movie, row.seasonKey, row.episodeKey));
                row.viewedHash = viewedHash(object.movie, row.seasonKey, row.episodeKey, row.voice);

                var item = Lampa.Template.get(ITEM_TEMPLATE_NAME, row);

                item.append(Lampa.Timeline.render(row.timeline));
                if (Lampa.Timeline.details) {
                    item.find('.online__quality').append(Lampa.Timeline.details(row.timeline, ' / '));
                }

                if (viewed.indexOf(row.viewedHash) !== -1) {
                    item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
                }

                item.on('hover:enter', function () {
                    playRow(object.movie, row, results, isSeries, viewed, item);
                });

                item.on('hover:focus', function (e) {
                    last = e.target;
                    scroll.update($(e.target), true);
                });

                var contextEntry = { item: item, row: row, viewed: viewed };
                contextRows.push(contextEntry);
                attachContextMenu(item, row, viewed, contextRows);

                scroll.append(item);
            });

            self.activity.loader(false);
        }

        function showEmptyState(message) {
            self.activity.loader(false);
            var empty = Lampa.Template.get('list_empty');
            empty.find('.empty__descr').text(message);
            scroll.render().find('.empty').remove();
            scroll.clear();
            scroll.append(empty);
        }

        function loadData() {
            self.activity.loader(true);

            requestBackendData(
                object.movie,
                function onSuccess(data) {
                    normalizedData = data;
                    availableProviders = collectAvailableProviders();

                    if (!availableProviders.length) {
                        showEmptyState('Ни один провайдер не вернул ссылок для этого тайтла');
                        return;
                    }

                    selectedProvider = pickInitialProvider();
                    resetSeasonAndVoiceForProvider();
                    applyFilterUI();
                    renderList();
                },
                function onError() {
                    showEmptyState('Не удалось получить данные от бэкенда');
                    Lampa.Noty.show('Ошибка запроса к бэкенду');
                }
            );
        }

        this.inActivity = function () {
            var body = $('body');
            return !(
                body.hasClass('settings--open') ||
                body.hasClass('menu--open') ||
                body.hasClass('keyboard-input--visible') ||
                body.hasClass('selectbox--open') ||
                body.hasClass('search--open') ||
                $('div.modal').length
            );
        };

        this.create = function () {
            this.activity.loader(true);

            filter.onSearch = function () {};
            filter.onBack = function () {
                self.start();
            };

            filter.onSelect = function (type, a, b) {
                if (type === 'filter') {
                    if (a.reset) {
                        resetSeasonAndVoiceForProvider();
                        applyFilterUI();
                        renderList();
                    } else if (a.stype === 'season') {
                        selectedSeasonKey = b.key;
                        resetVoiceForSeason();
                        applyFilterUI();
                        renderList();
                        setTimeout(self.closeFilter, 10);
                    } else if (a.stype === 'voice') {
                        selectedVoice = b.title;
                        applyFilterUI();
                        renderList();
                        setTimeout(self.closeFilter, 10);
                    }
                } else if (type === 'sort') {
                    // Переключение провайдера — БЕЗ повторного сетевого запроса.
                    selectedProvider = a.provider;
                    saveSelectedProvider(selectedProvider);
                    resetSeasonAndVoiceForProvider();
                    applyFilterUI();
                    renderList();
                    setTimeout(self.closeFilter, 10);
                }
            };

            files.appendHead(filter.render());
            files.appendFiles(scroll.render());

            loadData();

            return this.render();
        };

        this.closeFilter = function () {
            if ($('body').hasClass('selectbox--open')) Lampa.Select.close();
        };

        this.render = function () {
            return files.render();
        };

        this.start = function () {
            Lampa.Background.immediately(Lampa.Utils.cardImgBackground(object.movie));

            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render(), files.render());
                    Lampa.Controller.collectionFocus(last || false, scroll.render());
                },
                up: function () {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () {
                    Navigator.move('down');
                },
                right: function () {
                    if (Navigator.canmove('right')) Navigator.move('right');
                    else filter.show('Фильтр', 'filter');
                },
                left: function () {
                    if (Navigator.canmove('left')) Navigator.move('left');
                    else Lampa.Controller.toggle('menu');
                },
                back: function () {
                    Lampa.Activity.backward();
                }
            });

            if (this.inActivity()) Lampa.Controller.toggle('content');
        };

        this.pause = function () {};
        this.stop = function () {};

        this.destroy = function () {
            files.destroy();
            scroll.destroy();
        };
    }

    /**
     * ========================================================================
     * 12. ЗАПУСК ИСТОЧНИКА
     * ========================================================================
     */
    function openBalancerActivity(movie) {
        Lampa.Activity.push({
            url: '',
            title: movie.title || movie.name || PLUGIN_TITLE,
            component: COMPONENT_NAME,
            movie: movie,
            page: 1
        });
    }

    /**
     * ========================================================================
     * 13. КНОПКА "BALANCER" НА КАРТОЧКЕ ФИЛЬМА
     * ========================================================================
     */
    function attachBalancerButtonToCard() {
        Lampa.Listener.follow('full', function (e) {
            if (e.type !== 'complite' || !e.data || !e.data.movie) return;

            var root = e.object.activity.render();

            if (root.find('.view--balancer').length) return;

            var button = $(
                '<div class="full-start__button selector view--balancer" data-subtitle="' + PLUGIN_TITLE + '">' +
                '<span>' + PLUGIN_TITLE + '</span>' +
                '</div>'
            );

            var isOpening = false;

            button.on('hover:enter', function () {
                if (isOpening) return;
                isOpening = true;

                Lampa.Component.add(COMPONENT_NAME, BalancerComponent);
                openBalancerActivity(e.data.movie);

                setTimeout(function () {
                    isOpening = false;
                }, 1000);
            });

            root.find('.view--torrent').after(button);
        });
    }

    /**
     * ========================================================================
     * 14. РЕГИСТРАЦИЯ ИСТОЧНИКА В LAMPA
     * ========================================================================
     */
    function registerBalancerPlugin() {
        Lampa.Component.add(COMPONENT_NAME, BalancerComponent);

        Lampa.Manifest.plugins = {
            type: 'video',
            version: '1.1.0',
            name: PLUGIN_TITLE,
            description: 'Источник воспроизведения через собственный backend',
            component: COMPONENT_NAME,
            onContextMenu: function () {
                return {
                    name: PLUGIN_TITLE,
                    description: ''
                };
            },
            onContextLauch: function (movie) {
                openBalancerActivity(movie);
            }
        };

        attachBalancerButtonToCard();
    }

    /**
     * ========================================================================
     * 15. ТОЧКА ВХОДА ПЛАГИНА
     * ========================================================================
     */
    function initPlugin() {
        if (window.balancer_plugin_ready) return;
        window.balancer_plugin_ready = true;

        registerBalancerPlugin();
    }

    if (window.appready) {
        initPlugin();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') initPlugin();
        });
    }
})();
