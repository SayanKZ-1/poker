# Подключение облака — выполняется владельцем

Эта версия ещё не опубликована. Для локального запуска аккаунты не нужны. Пароли и секреты в чат присылать не нужно.

1. Войти в GitHub и создать закрытый репозиторий. Загрузить исходник, исключив .env, data/, node_modules/. В репозитории должны остаться package-lock.json, db/, lib/, public/, scripts/ и supabase/.
2. Войти в Supabase и создать проект на бесплатном плане. Пароль базы сохранить у себя. В Authentication включить Anonymous Sign-Ins. Для первого теста используются отдельные браузерные личности, без Telegram.
3. В SQL Editor выполнить db/schema.sql, затем db/supabase.sql. Проверить в настройках Data API, что схема private не опубликована. В Database → Replication проверить таблицу svoi_views в supabase_realtime. Не давать клиентским ролям доступ к private.
4. В Cloudflare → Workers & Pages создать Pages-проект из GitHub. Build command: npm run build. Output directory: dist. Node: 22. Добавить только публичные переменные PUBLIC_SUPABASE_URL и PUBLIC_SUPABASE_PUBLISHABLE_KEY из Supabase. Сохранить выданный HTTPS-адрес *.pages.dev.
5. В Supabase → Edge Functions → Secrets добавить PUBLIC_ORIGIN (точный HTTPS origin Pages без завершающего /), DATABASE_URL (строка из Connect для transaction pooler, с паролем базы) и WORKER_SECRET (длинный случайный секрет, созданный и сохранённый у себя). Эти значения не вводить в публичные переменные Cloudflare.
6. В папке проекта выполнить npm ci и npm run build. Авторизовать Supabase CLI у себя через npx supabase login, затем привязать выбранный проект: npx supabase link --project-ref ВАШ_PROJECT_REF. Развернуть функцию: npx supabase functions deploy game. Файл supabase/config.toml отключает проверку JWT шлюзом: внутри функция проверяет пользователя через Supabase Auth, а worker — отдельным секретом. Не удалять эти проверки.
7. В Supabase включить расширения pg_cron и pg_net. В Vault создать svoi_worker_url со значением https://ВАШ_PROJECT_REF.supabase.co/functions/v1/game/tick и svoi_worker_secret с тем же значением, что WORKER_SECRET. Выполнить db/worker.sql. Без этой настройки таймауты, автораздача и снятие паузы администратора без клиентов не работают автономно.
8. Проверить Health/Security Advisors в Supabase, Cron job run details и журналы Edge Function. Просроченные комнаты вызывают worker; пустой сервер не должен постоянно расходовать вызовы Edge. Бесплатный план имеет квоты; стоимость/лимиты проверить в своём аккаунте перед постоянной игрой.
9. Открыть HTTPS-ссылку на двух телефонах, создать комнату, войти по коду и проверить игру. На iPhone: Safari → Поделиться → На экран «Домой». На Android: меню браузера → Установить приложение / Добавить на главный экран.

Облачная часть, действительность конкретных аккаунтов, доступность бесплатных квот и работа на физических устройствах в этой поставке не проверены.

Официальная документация: https://supabase.com/docs/guides/auth/auth-anonymous, https://supabase.com/docs/guides/realtime/postgres-changes, https://supabase.com/docs/guides/cron, https://developers.cloudflare.com/pages/framework-guides/deploy-anything/.
