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
     * 5. ОКНО ВЫБОРА БАЛАНСЕРА
     * ========================================================================
     */
    function showBalancerSelectionWindow(onSelect, onCancel) {
        if (!BALANCERS.length) {
            Lampa.Noty.show('Список балансеров пуст. Добавьте балансеры в массив BALANCERS в файле плагина.');
            onCancel();
            return;
        }

        var currentBalancer = getCurrentBalancer();

        var items = BALANCERS.map(function (balancer) {
            return {
                title: balancer.name,
                subtitle: (currentBalancer && currentBalancer.url === balancer.url) ? 'Текущий' : balancer.url,
                selected: !!(currentBalancer && currentBalancer.url === balancer.url),
                balancer: balancer
            };
        });

        Lampa.Select.show({
            title: 'Выбор балансера',
            items: items,
            onSelect: function (selectedItem) {
                onSelect(selectedItem.balancer);
            },
            onBack: function () {
                onCancel();
            }
        });
    }

    /**
     * ========================================================================
     * 6. ОТОБРАЖЕНИЕ ОТВЕТА БАЛАНСЕРА И ЗАПУСК ПЛЕЕРА
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
                title: title
            }
        ]);
    }

    function showPlaybackVariants(results, movie, onBack) {
        if (!results || !results.length) {
            Lampa.Noty.show('Балансер не вернул вариантов воспроизведения.');
            onBack();
            return;
        }

        var items = results.map(function (variant) {
            return {
                title: variant.title || movie.title || movie.name || '',
                subtitle: variant.quality || '',
                variant: variant
            };
        });

        Lampa.Select.show({
            title: 'Выбор варианта воспроизведения',
            items: items,
            onSelect: function (item) {
                playVariant(item.variant, movie);
            },
            onBack: onBack
        });
    }

    function showSeriesEpisodes(episodes, movie, onBack) {
        var items = episodes.map(function (episode) {
            return {
                title: episode.title || ('Серия ' + episode.episode),
                episode: episode
            };
        });

        Lampa.Select.show({
            title: 'Выбор серии',
            items: items,
            onSelect: function (item) {
                showPlaybackVariants(item.episode.results, movie, function () {
                    showSeriesEpisodes(episodes, movie, onBack);
                });
            },
            onBack: onBack
        });
    }

    function showSeriesSeasons(seasons, movie, onBack) {
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
                showSeriesEpisodes(item.season.episodes, movie, function () {
                    showSeriesSeasons(seasons, movie, onBack);
                });
            },
            onBack: onBack
        });
    }

    function showBalancerResponse(data, movie, onBack) {
        if (data && data.type === 'series' && data.seasons && data.seasons.length) {
            showSeriesSeasons(data.seasons, movie, onBack);
        } else if (data && data.results && data.results.length) {
            showPlaybackVariants(data.results, movie, onBack);
        } else {
            Lampa.Noty.show('Балансер не вернул данных для воспроизведения.');
            onBack();
        }
    }

    /**
     * ========================================================================
     * 7. КОМПОНЕНТ ИСТОЧНИКА
     * ========================================================================
     */
    function BalancerComponent(object) {
        var html = $('<div class="balancer-plugin"></div>');
        var activeNetworkRequest = null;

        function renderMessage(text) {
            html.empty();
            html.append($('<div class="balancer-plugin__message" style="padding:1em;">' + text + '</div>'));
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
                    renderMessage('Выбор варианта воспроизведения…');

                    showBalancerResponse(data, object.movie, function () {
                        Lampa.Activity.backward();
                    });
                },
                function onError() {
                    renderMessage('Не удалось получить данные от балансера "' + balancer.name + '".');
                    Lampa.Noty.show('Ошибка запроса к балансеру "' + balancer.name + '"');
                }
            );
        }

        function openBalancerSelection() {
            showBalancerSelectionWindow(
                function onSelect(balancer) {
                    saveSelectedBalancer(balancer);
                    loadDataFromCurrentBalancer();
                },
                function onCancel() {
                    Lampa.Activity.backward();
                }
            );
        }

        this.create = function () {
            this.activity.loader(true);
            renderMessage('Выбор балансера…');
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
            // Отображение контента и так работает через render(), toggle() тут не нужен.

            Lampa.Controller.add('content', {
                toggle: function () {},
                back: function () {
                    Lampa.Activity.backward();
                }
            });

            Lampa.Controller.toggle('content');

            if (BALANCERS.length === 1) {
                if (!getCurrentBalancer()) saveSelectedBalancer(BALANCERS[0]);
                loadDataFromCurrentBalancer();
            } else {
                var saved = getCurrentBalancer();
                if (saved) loadDataFromCurrentBalancer();
                else openBalancerSelection();
            }
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
