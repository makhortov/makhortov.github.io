(function () {
    'use strict';

    // ====== РЕЕСТР ИСТОЧНИКОВ ======
    // Каждый источник — объект с name и функцией search(movie) -> Promise<Array<{title, quality, url}>>
    // Подключайте сюда СВОИ легальные API (собственный бэкенд, лицензированный каталог и т.д.)
    var SOURCES = [
        {
            id: 'source_a',
            name: 'Источник A',
            search: function (movie) {
                // ЗАМЕНИТЕ на реальный запрос к вашему легальному API
                return fetch('https://api.example.com/search?title=' + encodeURIComponent(movie.title))
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        // ожидаем массив { title, quality, url }
                        return data.results || [];
                    })
                    .catch(function () { return []; });
            }
        },
        {
            id: 'source_b',
            name: 'Источник B',
            search: function (movie) {
                return fetch('https://api2.example.com/find?q=' + encodeURIComponent(movie.title))
                    .then(function (r) { return r.json(); })
                    .then(function (data) { return data.items || []; })
                    .catch(function () { return []; });
            }
        }
        // Добавляйте новые источники по этому же шаблону
    ];

    // ====== КОМПОНЕНТ ВЫБОРА ИСТОЧНИКА ======
    function MultiSourceComponent(object) {
        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var files_last = new Lampa.Explorer(object);
        var active = 0;

        this.create = function () {
            this.buildSourceList();
            return this.render();
        };

        this.buildSourceList = function () {
            var body = $('<div class="source-list"></div>');

            SOURCES.forEach(function (src) {
                var item = $(
                    '<div class="selectbox-item selector" data-id="' + src.id + '">' +
                        '<div class="selectbox-item__title">' + src.name + '</div>' +
                    '</div>'
                );

                item.on('hover:enter', function () {
                    Lampa.Loading.start();
                    src.search(object.movie).then(function (results) {
                        Lampa.Loading.stop();
                        if (!results.length) {
                            Lampa.Noty.show('Ничего не найдено в ' + src.name);
                            return;
                        }
                        showResultsList(results, src.name);
                    });
                });

                body.append(item);
            });

            scroll.append(body);
        };

        function showResultsList(results, sourceName) {
            var body = $('<div class="results-list"></div>');

            results.forEach(function (res) {
                var line = $(
                    '<div class="selectbox-item selector">' +
                        '<div class="selectbox-item__title">' +
                            (res.title || sourceName) + ' — ' + (res.quality || '') +
                        '</div>' +
                    '</div>'
                );

                line.on('hover:enter', function () {
                    Lampa.Player.play({
                        url: res.url,
                        title: object.movie.title,
                        quality: res.quality || 'auto'
                    });
                    Lampa.Player.playlist([{ url: res.url, title: object.movie.title }]);
                });

                body.append(line);
            });

            scroll.clear();
            scroll.append(body);
            scroll.update();
        }

        this.render = function () {
            return scroll.render();
        };

        this.start = function () {
            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectSet(scroll.render(), scroll.render());
                    Lampa.Controller.focus();
                },
                back: this.back
            });
            Lampa.Controller.toggle('content');
        };

        this.back = function () {
            Lampa.Activity.backward();
        };

        this.destroy = function () {
            scroll.destroy();
        };
    }

    Lampa.Component.add('multisource', MultiSourceComponent);

    // ====== ДОБАВЛЕНИЕ КНОПКИ НА КАРТОЧКУ ФИЛЬМА ======
    function addButtonToCard(root, object) {
        var button = $(
            '<div class="full-start__button selector view--multisource" data-subtitle="Источники">' +
                '<span>Выбрать источник</span>' +
            '</div>'
        );

        button.on('hover:enter', function () {
            Lampa.Activity.push({
                url: '',
                title: 'Источники — ' + object.movie.title,
                component: 'multisource',
                movie: object.movie,
                page: 1
            });
        });

        root.find('.view--torrent').after(button); // ставим рядом с существующими кнопками
    }

    function startPlugin() {
        Lampa.Platform.tv();

        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite' && e.data && e.data.movie) {
                addButtonToCard(e.object.activity.render(), e.data);
            }
        });
    }

    if (window.appready) startPlugin();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') startPlugin();
        });
    }
})();
