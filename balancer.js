/**
 * ПЛАГИН "Balancer" ДЛЯ LAMPA — адаптирован под uafilms/backend
 * ============================================================================
 * ВАЖНО: "балансеры" здесь — это ПРОВАЙДЕРЫ внутри ОДНОГО ответа API
 * (ashdi / hdvb / uaflix / ...), а не отдельные серверы. Бэкенд — один
 * (BACKEND_URL ниже), один запрос /api/get возвращает сразу все провайдеры:
 *
 *   { "providers": { "ashdi": [...], "hdvb": [...], "uaflix": [...] } }
 *
 * Переключение "балансера" в интерфейсе — это переключение между ключами
 * providers, БЕЗ повторного запроса к серверу (данные уже получены).
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
    var COMPONENT_NAME = 'balancer_source_component';
    var PLUGIN_TITLE = 'Balancer';
    var ITEM_TEMPLATE_NAME = 'balancer_item';

    /**
     * ========================================================================
     * 3. ЗАПРОС К БЭКЕНДУ И ПЕРЕВОД ОТВЕТА В УДОБНЫЙ ФОРМАТ
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

    // Приводит один элемент провайдера к единому виду.
    function mapProviderItem(item) {
        return {
            title: item.title || 'Original',
            quality: item.quality || 'Auto',
            url: item.url,
            subtitles: item.subtitles || []
        };
    }

    // providers: { ashdi: [...], hdvb: [...], ... } -> тот же вид, но
    // каждый элемент приведён к единому формату { title, quality, url, subtitles }.
    function mapProvidersObject(providers) {
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

    /**
     * Реальный формат ответа /api/get (подтверждено практикой):
     *   Фильм:   { "providers": { "ashdi": [...], "hdvb": [...], ... } }
     *   Сериал:  предположительно { "seasons": [ { number, episodes: [
     *              { season, episode, title, providers: {...} } ] } ] } —
     *            структура для сериала пока не проверена вживую; если формат
     *            окажется другим, эту ветку нужно будет доработать под то,
     *            что реально придёт (пришли пример ответа для сериала).
     */
    function normalizeBackendResponse(data) {
        if (!data) return null;

        if (data.seasons && data.seasons.length) {
            return {
                type: 'series',
                seasons: data.seasons.map(function (season) {
                    return {
                        season: season.number,
                        episodes: (season.episodes || []).map(function (ep) {
                            return {
                                episode: ep.episode,
                                title: ep.title || ('Серія ' + ep.episode),
                                providers: mapProvidersObject(ep.providers || {})
                            };
                        })
                    };
                })
            };
        }

        if (data.providers) {
            return {
                type: 'movie',
                providers: mapProvidersObject(data.providers)
            };
        }

        return null;
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
     * 4. СОХРАНЕНИЕ ВЫБРАННОГО ПРОВАЙДЕРА (переживает перезапуск приложения)
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
     * 5. ШАБЛОН ЭЛЕМЕНТА СПИСКА (как в online_mod: иконка play + название + качество)
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
     * 6. ЗАПУСК ПЛЕЕРА
     * ========================================================================
     */
    function playVariant(variant, movie) {
        if (!variant || !variant.url) {
            Lampa.Noty.show('У выбранного варианта нет ссылки на видео.');
            return;
        }

        var title = variant.title || movie.title || movie.name || '';

        Lampa.Player.play({
            url: variant.url,
            title: title,
            quality: variant.quality || 'auto',
            subtitles: variant.subtitles || []
        });

        Lampa.Player.playlist([
            {
                url: variant.url,
                title: title,
                subtitles: variant.subtitles || []
            }
        ]);
    }

    /**
     * ========================================================================
     * 7. КОМПОНЕНТ ИСТОЧНИКА — на базе Lampa.Explorer/Filter/Scroll
     * ========================================================================
     * "Балансер" в кнопке сортировки (filter--sort) переключает между
     * ПРОВАЙДЕРАМИ уже полученного ответа — без повторного сетевого запроса.
     */
    function BalancerComponent(object) {
        registerItemTemplate();

        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var files = new Lampa.Explorer(object);
        var filter = new Lampa.Filter(object);

        var normalizedData = null;
        var availableProviders = [];
        var selectedProvider = '';
        var choice = { season: 0 };
        var last = null;
        var self = this;

        scroll.body().addClass('torrent-list');
        scroll.minus(files.render().find('.explorer__files-head'));

        // Собирает список провайдеров, реально присутствующих в ответе.
        // Для сериала — объединение провайдеров по всем сезонам/сериям
        // (набор провайдеров обычно одинаковый для всего тайтла).
        function collectAvailableProviders() {
            var names = {};

            if (normalizedData.type === 'movie') {
                Object.keys(normalizedData.providers).forEach(function (name) {
                    if (normalizedData.providers[name].length) names[name] = true;
                });
            } else if (normalizedData.type === 'series') {
                normalizedData.seasons.forEach(function (season) {
                    season.episodes.forEach(function (ep) {
                        Object.keys(ep.providers || {}).forEach(function (name) {
                            if (ep.providers[name].length) names[name] = true;
                        });
                    });
                });
            }

            return Object.keys(names);
        }

        function pickInitialProvider() {
            var saved = getSavedProvider();
            if (saved && availableProviders.indexOf(saved) !== -1) return saved;
            return availableProviders[0] || '';
        }

        function applyFilterUI() {
            var select = [];
            var seasonNames = [];

            if (normalizedData.type === 'series') {
                seasonNames = normalizedData.seasons.map(function (s) {
                    return 'Сезон ' + s.season;
                });
            }

            select.push({ title: 'Сбросить', reset: true });

            if (seasonNames.length) {
                var seasonItems = seasonNames.map(function (name, i) {
                    return { title: name, selected: i === choice.season, index: i };
                });
                select.push({
                    title: 'Сезон',
                    subtitle: seasonNames[choice.season],
                    items: seasonItems,
                    stype: 'season'
                });
            }

            filter.set('filter', select);

            // "Балансер" здесь = переключатель провайдера (ashdi/hdvb/uaflix/...).
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
            if (seasonNames.length) chosen.push('Сезон: ' + seasonNames[choice.season]);
            filter.chosen('filter', chosen);
            filter.chosen('sort', [selectedProvider || '—']);
        }

        // Список результатов для текущего выбранного провайдера.
        function currentResults() {
            if (!normalizedData || !selectedProvider) return [];

            if (normalizedData.type === 'series') {
                var season = normalizedData.seasons[choice.season];
                if (!season) return [];

                var flat = [];
                season.episodes.forEach(function (ep) {
                    var items = (ep.providers && ep.providers[selectedProvider]) || [];
                    items.forEach(function (variant) {
                        flat.push({
                            title: 'Серия ' + ep.episode + ' — ' + variant.title,
                            quality: variant.quality,
                            info: variant.subtitles && variant.subtitles.length ? ' / CC' : '',
                            variant: variant
                        });
                    });
                });
                return flat;
            }

            var providerItems = normalizedData.providers[selectedProvider] || [];
            return providerItems.map(function (variant) {
                return {
                    title: variant.title,
                    quality: variant.quality,
                    info: variant.subtitles && variant.subtitles.length ? ' / CC' : '',
                    variant: variant
                };
            });
        }

        function renderList() {
            scroll.render().find('.empty').remove();
            scroll.clear();

            var results = currentResults();

            if (!results.length) {
                var empty = Lampa.Template.get('list_empty');
                empty.find('.empty__descr').text('Провайдер не вернул вариантов воспроизведения');
                scroll.append(empty);
                self.activity.loader(false);
                return;
            }

            results.forEach(function (element) {
                var item = Lampa.Template.get(ITEM_TEMPLATE_NAME, element);

                item.on('hover:enter', function () {
                    playVariant(element.variant, object.movie);
                });

                item.on('hover:focus', function (e) {
                    last = e.target;
                    scroll.update($(e.target), true);
                });

                scroll.append(item);
            });

            self.activity.loader(false);
        }

        function loadData() {
            self.activity.loader(true);

            requestBackendData(
                object.movie,
                function onSuccess(data) {
                    normalizedData = data;
                    availableProviders = collectAvailableProviders();

                    if (!availableProviders.length) {
                        self.activity.loader(false);
                        var empty = Lampa.Template.get('list_empty');
                        empty.find('.empty__descr').text('Ни один провайдер не вернул ссылок для этого тайтла');
                        scroll.render().find('.empty').remove();
                        scroll.clear();
                        scroll.append(empty);
                        return;
                    }

                    selectedProvider = pickInitialProvider();
                    choice.season = 0;
                    applyFilterUI();
                    renderList();
                },
                function onError() {
                    self.activity.loader(false);
                    Lampa.Noty.show('Ошибка запроса к бэкенду');
                    var empty = Lampa.Template.get('list_empty');
                    empty.find('.empty__descr').text('Не удалось получить данные от бэкенда');
                    scroll.render().find('.empty').remove();
                    scroll.clear();
                    scroll.append(empty);
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
                        choice.season = 0;
                        applyFilterUI();
                        renderList();
                    } else if (a.stype === 'season') {
                        choice.season = b.index;
                        applyFilterUI();
                        renderList();
                        setTimeout(self.closeFilter, 10);
                    }
                } else if (type === 'sort') {
                    // Переключение провайдера — БЕЗ повторного сетевого запроса,
                    // данные уже есть в normalizedData.
                    selectedProvider = a.provider;
                    saveSelectedProvider(selectedProvider);
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
     * 8. ЗАПУСК ИСТОЧНИКА
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
     * 9. КНОПКА "BALANCER" НА КАРТОЧКЕ ФИЛЬМА
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
     * 10. РЕГИСТРАЦИЯ ИСТОЧНИКА В LAMPA
     * ========================================================================
     */
    function registerBalancerPlugin() {
        Lampa.Component.add(COMPONENT_NAME, BalancerComponent);

        Lampa.Manifest.plugins = {
            type: 'video',
            version: '1.0.0',
            name: PLUGIN_TITLE,
            description: 'Источник воспроизведения через uafilms/backend на моей Raspberry Pi',
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
     * 11. ТОЧКА ВХОДА ПЛАГИНА
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
