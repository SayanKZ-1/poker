# Подключение облака

Текущая публикация: https://poker-9n5.pages.dev. Репозиторий: https://github.com/SayanKZ-1/poker. Пароли и секреты в чат присылать не нужно.

1. Войти в GitHub и создать закрытый репозиторий. Загрузить исходник, исключив .env, data/, node_modules/. В репозитории должны остаться package-lock.json, db/, lib/, public/, scripts/ и supabase/.
2. Войти в Supabase и создать проект на бесплатном плане. Пароль базы сохранить у себя. В Authentication включить Anonymous Sign-Ins. Для первого теста используются отдельные браузерные личности, без Telegram.
3. В SQL Editor выполнить db/schema.sql, затем db/supabase.sql. Проверить в настройках Data API, что схема private не опубликована. В Database → Replication проверить таблицу svoi_views в supabase_realtime. Не давать клиентским ролям доступ к private.
4. В Cloudflare → Workers & Pages создать Pages-проект из GitHub. Build command: npm run build. Output directory: dist. Node: 22. Добавить только публичные переменные PUBLIC_SUPABASE_URL и PUBLIC_SUPABASE_PUBLISHABLE_KEY из Supabase. Сохранить выданный HTTPS-адрес *.pages.dev.
5. В Supabase → Edge Functions → Secrets добавить PUBLIC_ORIGIN (точный HTTPS origin Pages без завершающего /) и WORKER_SECRET (длинный случайный секрет). `SUPABASE_DB_URL` уже предоставляется размещённой функции платформой. Эти значения не вводить в публичные переменные Cloudflare.
6. В папке проекта выполнить npm ci и npm run build. Авторизовать Supabase CLI у себя через npx supabase login, затем развернуть функцию: npx supabase functions deploy game --project-ref ВАШ_PROJECT_REF. Проверка JWT шлюзом включена. Клиентские запросы дополнительно проверяются через Supabase Auth, а `/tick` — отдельным WORKER_SECRET.
7. В Supabase включить расширения pg_cron и pg_net. В Vault создать `svoi_worker_url`, `svoi_worker_jwt` (legacy anon JWT только для проверки шлюзом) и `svoi_worker_secret`. Выполнить db/worker.sql. Без этой настройки таймауты, автораздача и снятие паузы администратора без клиентов не работают автономно.
8. Проверить Health/Security Advisors в Supabase, Cron job run details и журналы Edge Function. Просроченные комнаты вызывают worker; пустой сервер не должен постоянно расходовать вызовы Edge. Бесплатный план имеет квоты; стоимость/лимиты проверить в своём аккаунте перед постоянной игрой.
9. Открыть HTTPS-ссылку на двух телефонах, создать комнату, войти по коду и проверить игру. На iPhone: Safari → Поделиться → На экран «Домой». На Android: меню браузера → Установить приложение / Добавить на главный экран.

Публикация и статические PWA-ресурсы проверены. Игровые сценарии и работа на физических устройствах оставлены владельцу для самостоятельного прогона.

Официальная документация: https://supabase.com/docs/guides/auth/auth-anonymous, https://supabase.com/docs/guides/realtime/postgres-changes, https://supabase.com/docs/guides/cron, https://developers.cloudflare.com/pages/framework-guides/deploy-anything/.
