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
     * 5. СТИЛИ ЭКРАНА (постер + название + ряд балансеров + список вариантов)
     * ========================================================================
     * Внедряются один раз при первой загрузке плагина. Без внешнего CSS-файла
     * — всё нужное для разметки лежит здесь.
     */
    function injectStyles() {
        if (document.getElementById('balancer-plugin-styles')) return;

        var style = document.createElement('style');
        style.id = 'balancer-plugin-styles';
        style.textContent =
            '.balancer-plugin{padding:1.5em 0 3em}' +
            '.balancer-plugin__balancers{display:flex;gap:.6em;padding:0 1.5em 1.5em;flex-wrap:wrap}' +
            '.balancer-plugin__balancer-tab{padding:.5em 1.2em;border-radius:.5em;background:rgba(255,255,255,.08);font-size:1.1em;cursor:pointer}' +
            '.balancer-plugin__balancer-tab.active{background:rgba(255,255,255,.9);color:#000;font-weight:600}' +
            '.balancer-plugin__balancer-tab.focus{box-shadow:0 0 0 .15em rgba(255,255,255,.9)}' +
            '.balancer-plugin__body{display:flex;gap:2em;padding:0 1.5em}' +
            '.balancer-plugin__poster{flex:0 0 auto}' +
            '.balancer-plugin__poster img{width:220px;border-radius:.6em;display:block;box-shadow:0 .3em 1em rgba(0,0,0,.4)}' +
            '.balancer-plugin__info{flex:1 1 auto;min-width:0}' +
            '.balancer-plugin__title{font-size:1.7em;font-weight:600;margin-bottom:.2em}' +
            '.balancer-plugin__subtitle{opacity:.7;margin-bottom:1.2em}' +
            '.balancer-plugin__variants{display:flex;flex-direction:column;gap:.6em}' +
            '.balancer-plugin__variant{display:flex;justify-content:space-between;align-items:center;gap:1em}' +
            '.balancer-plugin__variant-quality{opacity:.7;font-size:.9em;white-space:nowrap}' +
            '.balancer-plugin__cc{font-size:.7em;opacity:.8;margin-left:.5em;border:1px solid currentColor;border-radius:.3em;padding:.05em .4em;vertical-align:middle}' +
            '.balancer-plugin__message{padding:1em 1.5em}';

        document.head.appendChild(style);
    }

    /**
     * ========================================================================
     * 6. ЗАПУСК ПЛЕЕРА
     * ========================================================================
     * Субтитры (если есть) передаются в Lampa.Player.play — плеер сам строит
     * из них меню выбора субтитров, отдельно реализовывать это не нужно.
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
     * 7. КОМПОНЕНТ ИСТОЧНИКА
     * ========================================================================
     * Экран: ряд переключения балансеров сверху -> постер + название ->
     * список вариантов озвучки/качества (с пометкой CC, если есть субтитры).
     * Для сериала сперва открываются окна выбора сезона/серии (Lampa.Select),
     * а результат конкретной серии отображается тем же списком вариантов.
     */
    function BalancerComponent(object) {
        injectStyles();

        var html = $('<div class="balancer-plugin"></div>');
        var activeNetworkRequest = null;

        function posterUrl(movie) {
            var path = movie && (movie.poster_path || movie.poster);
            if (!path) return '';
            return /^https?:\/\//.test(path) ? path : ('https://image.tmdb.org/t/p/w300' + path);
        }

        function renderMessage(text) {
            html.empty();
            html.append($('<div class="balancer-plugin__message">' + text + '</div>'));
        }

        // Ряд кнопок-балансеров сверху. Нажатие на другой балансер сохраняет
        // выбор и перезагружает данные текущего экрана (фильма/серии) с него.
        function renderBalancerRow(onSwitch) {
            var row = $('<div class="balancer-plugin__balancers"></div>');
            var current = getCurrentBalancer();

            BALANCERS.forEach(function (balancer) {
                var isActive = current && current.url === balancer.url;
                var tab = $(
                    '<div class="selector balancer-plugin__balancer-tab' + (isActive ? ' active' : '') + '">' +
                    balancer.name +
                    '</div>'
                );

                tab.on('hover:enter', function () {
                    if (!(current && current.url === balancer.url)) {
                        saveSelectedBalancer(balancer);
                    }
                    onSwitch();
                });

                row.append(tab);
            });

            return row;
        }

        // Список вариантов озвучки/качества под постером. onBack вызывается
        // кнопкой "Назад" — либо к списку серий (для сериала), либо на
        // карточку фильма.
        function renderVariantsList(container, results, movie) {
            var list = $('<div class="balancer-plugin__variants"></div>');

            results.forEach(function (variant) {
                var hasSubs = variant.subtitles && variant.subtitles.length;
                var item = $(
                    '<div class="selector full-start__button balancer-plugin__variant">' +
                    '<div>' + variant.title + (hasSubs ? ' <span class="balancer-plugin__cc">CC</span>' : '') + '</div>' +
                    '<div class="balancer-plugin__variant-quality">' + variant.quality + '</div>' +
                    '</div>'
                );

                item.on('hover:enter', function () {
                    playVariant(variant, movie);
                });

                list.append(item);
            });

            container.append(list);
        }

        // Рисует итоговый экран: балансеры сверху, постер+название, список
        // вариантов. subtitleText — например "Сезон 1 · Серия 3" для серий.
        function renderContentScreen(movie, results, subtitleText, onSwitchBalancer) {
            html.empty();

            html.append(renderBalancerRow(onSwitchBalancer));

            var body = $('<div class="balancer-plugin__body"></div>');
            var poster = posterUrl(movie);

            if (poster) {
                body.append($('<div class="balancer-plugin__poster"><img src="' + poster + '" /></div>'));
            }

            var info = $('<div class="balancer-plugin__info"></div>');
            info.append($('<div class="balancer-plugin__title">' + (movie.title || movie.name || '') + '</div>'));
            if (subtitleText) info.append($('<div class="balancer-plugin__subtitle">' + subtitleText + '</div>'));

            if (!results || !results.length) {
                info.append($('<div class="balancer-plugin__message">Балансер не вернул вариантов воспроизведения.</div>'));
            } else {
                renderVariantsList(info, results, movie);
            }

            body.append(info);
            html.append(body);

            Lampa.Controller.collectionSet(html);
            Lampa.Controller.collectionFocus(false, html);
        }

        function showSeriesEpisodes(seasons, seasonItem, movie, onSwitchBalancer, onBack) {
            var items = seasonItem.episodes.map(function (episode) {
                return {
                    title: episode.title || ('Серия ' + episode.episode),
                    episode: episode
                };
            });

            Lampa.Select.show({
                title: 'Выбор серии',
                items: items,
                onSelect: function (item) {
                    renderContentScreen(
                        movie,
                        item.episode.results,
                        'Сезон ' + seasonItem.season + ' · Серия ' + item.episode.episode,
                        onSwitchBalancer
                    );
                },
                onBack: onBack
            });
        }

        function showSeriesSeasons(seasons, movie, onSwitchBalancer, onBack) {
            var items = seasons.map(function (season) {
                return {
                    title: 'Сезон ' + season.season,
                    season: season
                };
            });

            Lampa.Select.show({
                title: 'Выбор сезона',
                items: items,
                onSelect: function (item) {
                    showSeriesEpisodes(seasons, item.season, movie, onSwitchBalancer, function () {
                        showSeriesSeasons(seasons, movie, onSwitchBalancer, onBack);
                    });
                },
                onBack: onBack
            });
        }

        function showBalancerResponse(data, movie, onSwitchBalancer) {
            if (data && data.type === 'series' && data.seasons && data.seasons.length) {
                showSeriesSeasons(data.seasons, movie, onSwitchBalancer, function () {
                    Lampa.Activity.backward();
                });
            } else if (data && data.results && data.results.length) {
                renderContentScreen(movie, data.results, '', onSwitchBalancer);
            } else {
                Lampa.Noty.show('Балансер не вернул данных для воспроизведения.');
                Lampa.Activity.backward();
            }
        }

        function loadDataFromCurrentBalancer() {
            var balancer = getCurrentBalancer();

            if (!balancer) {
                renderMessage('Балансер не выбран.');
                return;
            }

            renderMessage('Загрузка данных с балансера "' + balancer.name + '"…');

            activeNetworkRequest = requestBalancerData(
                balancer,
                object.movie,
                function onSuccess(data) {
                    showBalancerResponse(data, object.movie, loadDataFromCurrentBalancer);
                },
                function onError() {
                    renderMessage('Не удалось получить данные от балансера "' + balancer.name + '".');
                    Lampa.Noty.show('Ошибка запроса к балансеру "' + balancer.name + '"');
                }
            );
        }

        this.create = function () {
            this.activity.loader(true);
            renderMessage('Загрузка…');
            return this.render();
        };

        this.render = function (js) {
            return js ? html[0] : html;
        };

        this.start = function () {
            this.activity.loader(false);

            // ВАЖНО: не вызываем здесь this.activity.toggle() — именно этот
            // вызов внутри start() провоцировал бесконечную рекурсию через
            // ActivitySlide.start -> ActivitySlide.toggle -> BalancerComponent.start.

            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(html);
                    Lampa.Controller.collectionFocus(false, html);
                },
                back: function () {
                    Lampa.Activity.backward();
                }
            });

            Lampa.Controller.toggle('content');

            if (!getCurrentBalancer() && BALANCERS.length) saveSelectedBalancer(BALANCERS[0]);
            loadDataFromCurrentBalancer();
        };

        this.pause = function () {};
        this.stop = function () {};

        this.destroy = function () {
            if (activeNetworkRequest) activeNetworkRequest.clear();
            html.remove();
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
            title: PLUGIN_TITLE,
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

            // Защита от "залипающего" пульта: некоторые ТВ шлют несколько
            // hover:enter подряд на одно нажатие OK — без этой защиты каждое
            // такое событие пыталось открыть новую активность поверх ещё не
            // отрисованной предыдущей, что и приводило к рекурсии/зависанию.
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
