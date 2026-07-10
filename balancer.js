/**
 * ПЛАГИН "Balancer" ДЛЯ LAMPA — адаптирован под uafilms/backend
 * ============================================================================
 * Отличия от шаблона:
 *  - buildBalancerRequestUrl теперь строит запрос к /api/get?id=<tmdb_id>&type=<movie|tv>
 *  - добавлена normalizeBackendResponse(), которая переводит формат ответа
 *    бэкенда (sources / seasons[].number / seasons[].episodes[].episode)
 *    в формат, который использует остальной код шаблона (results / season / episode)
 *  - тип (movie/tv) определяется по наличию movie.name (у сериалов в Lampa
 *    объект фильма содержит name, у фильмов — title)
 * ============================================================================
 */
(function () {
    'use strict';

    /**
     * ========================================================================
     * 1. СПИСОК БАЛАНСЕРОВ
     * ========================================================================
     * Впиши сюда IP своей Raspberry Pi и порт, на котором слушает бэкенд.
     */
    var BALANCERS = [
        {
            name: 'Мой сервер (Raspberry Pi)',
            url: 'http://makhortov.duckdns.org:8088'
        }
    ];

    /**
     * ========================================================================
     * 2. КОНСТАНТЫ ПЛАГИНА
     * ========================================================================
     */
    var STORAGE_KEY = 'balancer_plugin_selected_url';
    var COMPONENT_NAME = 'balancer_source_component';
    var PLUGIN_TITLE = 'Balancer';

    /**
     * ========================================================================
     * 3. НАСТРОЙКИ: СОХРАНЕНИЕ И ВОССТАНОВЛЕНИЕ ВЫБРАННОГО БАЛАНСЕРА
     * ========================================================================
     */
    function saveSelectedBalancer(balancer) {
        Lampa.Storage.set(STORAGE_KEY, balancer.url);
    }

    function getSavedBalancerUrl() {
        return Lampa.Storage.get(STORAGE_KEY, null);
    }

    function getCurrentBalancer() {
        var savedUrl = getSavedBalancerUrl();
        if (!savedUrl) return null;

        var found = null;
        BALANCERS.forEach(function (balancer) {
            if (balancer.url === savedUrl) found = balancer;
        });

        return found;
    }

    /**
     * ========================================================================
     * 4. ПОЛУЧЕНИЕ ДАННЫХ ОТ БАЛАНСЕРА (адаптировано под uafilms/backend)
     * ========================================================================
     * Бэкенд ожидает: GET /api/get?id=<tmdb_id>&type=movie|tv
     * TMDB id уже лежит в объекте фильма, который Lampa передаёт компоненту
     * (movie.id) — отдельно искать/сопоставлять ничего не нужно.
     */

    // Определяет тип контента так, как это делает сама Lampa: у сериалов
    // объект фильма содержит поле name, у фильмов — title (и name отсутствует).
    function detectContentType(movie) {
        return movie && movie.name ? 'tv' : 'movie';
    }

    function buildBalancerRequestUrl(balancer, movie) {
        var tmdbId = movie && movie.id;
        var type = detectContentType(movie);

        return balancer.url + '/api/get?id=' + encodeURIComponent(tmdbId) + '&type=' + encodeURIComponent(type);
    }

    /**
     * Переводит "родной" формат ответа uafilms/backend в формат, с которым
     * работает остальной код плагина (showBalancerResponse и ниже).
     *
     * Бэкенд для фильма отдаёт:
     *   { sources: [ { provider, dub, quality, url, type, subtitles }, ... ] }
     *
     * Бэкенд для сериала отдаёт:
     *   { seasons: [ { number, episodes: [ { season, episode, title, sources: [...] } ] } ] }
     *
     * Приводим source-объект к виду { title, quality, url }, где title
     * собирается из озвучки (dub) и провайдера — так пользователь видит,
     * что за источник выбирает.
     */
    function mapSourceToVariant(source) {
        return {
            title: (source.dub || 'Original') + ' [' + (source.provider || '?') + ']',
            quality: source.quality || 'Auto',
            url: source.url,
            subtitles: source.subtitles || []
        };
    }

    /**
     * Переводит "родной" формат ответа uafilms/backend в формат, с которым
     * работает остальной код плагина (showBalancerResponse и ниже).
     *
     * РЕАЛЬНЫЙ формат ответа /api/get (подтверждено логами с устройства):
     *   {
     *     "providers": {
     *       "hdvb":    [ { title, url, mime, subtitles, poster, headers }, ... ],
     *       "uaflix":  [ { title, url, mime, subtitles, poster, headers }, ... ],
     *       "tortuga": [ ... ]
     *     }
     *   }
     * Ключ providers — плоский список источников по провайдерам, без разбивки
     * на сезоны/серии в этом объекте. Для сериалов структура пока не
     * подтверждена практикой — если после теста на сериале появится другой
     * формат (например, providers содержит season/episode в каждом элементе),
     * этот блок нужно будет доработать под то, что реально придёт.
     */
    function flattenProviders(providers) {
        var results = [];

        Object.keys(providers || {}).forEach(function (providerName) {
            var items = providers[providerName] || [];

            items.forEach(function (item) {
                if (!item || !item.url) return;

                results.push({
                    title: (item.title || 'Original') + ' [' + providerName + ']',
                    quality: item.quality || 'Auto',
                    url: item.url,
                    subtitles: item.subtitles || []
                });
            });
        });

        return results;
    }

    function normalizeBackendResponse(data) {
        if (!data) return null;

        // Основной формат — providers (подтверждён реальным ответом сервера).
        if (data.providers) {
            var flat = flattenProviders(data.providers);
            if (flat.length) return { results: flat };
        }

        // Резервная поддержка формата sources/seasons — на случай, если для
        // сериалов бэкенд отдаёт другую структуру (пока не проверено).
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
                                results: ep.providers ? flattenProviders(ep.providers) : (ep.sources || []).map(mapSourceToVariant)
                            };
                        })
                    };
                })
            };
        }

        if (data.sources && data.sources.length) {
            return {
                results: data.sources.map(mapSourceToVariant)
            };
        }

        return null;
    }

    function requestBalancerData(balancer, movie, onSuccess, onError) {
        var network = new Lampa.Reguest();

        network.timeout(15000);

        network.silent(
            buildBalancerRequestUrl(balancer, movie),
            function (data) {
                var normalized = normalizeBackendResponse(data);
                if (normalized) onSuccess(normalized);
                else onError(new Error('Empty response'));
            },
            function (error) {
                onError(error);
            }
        );

        return network;
    }

    /**
     * ========================================================================
     * 5. ШАБЛОН ЭЛЕМЕНТА СПИСКА (как в online_mod: иконка play + название + качество)
     * ========================================================================
     */
    var ITEM_TEMPLATE_NAME = 'balancer_item';

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
     * Переключатель балансера сделан ТАК ЖЕ, как "Балансер" в online_mod:
     * подпись на кнопке сортировки Explorer'а (filter--sort) + системное
     * окно выбора через filter.set('sort', ...). Список результатов —
     * стандартный Lampa.Scroll с элементами по шаблону 'online_mod'-типа,
     * поэтому фокус/навигация пультом работают из коробки, без ручного
     * Controller.collectionFocus на самодельной разметке.
     */
    function BalancerComponent(object) {
        registerItemTemplate();

        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var files = new Lampa.Explorer(object);
        var filter = new Lampa.Filter(object);

        var normalizedData = null;
        var choice = { season: 0 };
        var last = null;
        var self = this;

        scroll.body().addClass('torrent-list');
        scroll.minus(files.render().find('.explorer__files-head'));

        function currentBalancerIndex() {
            var current = getCurrentBalancer();
            var idx = 0;
            BALANCERS.forEach(function (b, i) {
                if (current && b.url === current.url) idx = i;
            });
            return idx;
        }

        // Строит выпадающий фильтр (иконка слева) и подпись+список кнопки
        // сортировки (справа, "Балансер") — так же, как component.filter()
        // в оригинальном online_mod.
        function applyFilterUI() {
            var select = [];
            var seasonNames = [];

            if (normalizedData && normalizedData.type === 'series') {
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

            // Кнопка сортировки — используем как переключатель балансера,
            // ровно как это делает online_mod (см. filter--sort span).
            filter.render().find('.filter--sort span').text('Балансер');
            filter.set(
                'sort',
                BALANCERS.map(function (b, i) {
                    return {
                        title: b.name,
                        balancer: b,
                        selected: i === currentBalancerIndex()
                    };
                })
            );

            var chosen = [];
            if (seasonNames.length) chosen.push('Сезон: ' + seasonNames[choice.season]);
            filter.chosen('filter', chosen);

            var currentBalancer = BALANCERS[currentBalancerIndex()];
            filter.chosen('sort', [currentBalancer ? currentBalancer.name : '']);
        }

        // Собирает плоский список для показа: для фильма — сразу sources,
        // для сериала — варианты выбранного сезона (все серии + все
        // источники), с префиксом "Серия N" в названии.
        function currentResults() {
            if (!normalizedData) return [];

            if (normalizedData.type === 'series') {
                var season = normalizedData.seasons[choice.season];
                if (!season) return [];

                var flat = [];
                season.episodes.forEach(function (ep) {
                    (ep.results || []).forEach(function (variant) {
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

            return (normalizedData.results || []).map(function (variant) {
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
                empty.find('.empty__descr').text('Балансер не вернул вариантов воспроизведения');
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
            var balancer = getCurrentBalancer();

            if (!balancer) {
                self.activity.loader(false);
                return;
            }

            self.activity.loader(true);

            requestBalancerData(
                balancer,
                object.movie,
                function onSuccess(data) {
                    normalizedData = data;
                    choice.season = 0;
                    applyFilterUI();
                    renderList();
                },
                function onError() {
                    self.activity.loader(false);
                    Lampa.Noty.show('Ошибка запроса к балансеру "' + balancer.name + '"');
                }
            );
        }

        function changeBalancer(balancer) {
            saveSelectedBalancer(balancer);
            loadData();
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
                    changeBalancer(a.balancer);
                    setTimeout(self.closeFilter, 10);
                }
            };

            files.appendHead(filter.render());
            files.appendFiles(scroll.render());

            if (!getCurrentBalancer() && BALANCERS.length) saveSelectedBalancer(BALANCERS[0]);
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
            var _this = this;

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
