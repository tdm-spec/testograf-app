# Первый запуск

## Firebase

1. В Firebase Console откройте проект PSN Hub `travel-edu-app`.
2. В Authentication -> Sign-in method включите `Email/Password` и `Anonymous`.
3. В Authentication -> Users создайте администратора `psnkzeducation@gmail.com` и задайте надежный пароль.
4. Установите Firebase CLI и выполните вход: `firebase login`.
5. Из папки проекта примените правила: `firebase deploy --only firestore:rules --project travel-edu-app`.

Без применения `firestore.rules` результаты и административные данные не будут защищены новыми правилами.

## Cloudflare Pages

1. В Pages project -> Settings -> Bindings проверьте KV binding `TESTOGRAF_TESTS`.
2. Namespace ID должен совпадать со значением в `wrangler.toml`.
3. Проверьте переменную `FIREBASE_API_KEY`: для первого запуска она уже указана в `wrangler.toml` как публичный Firebase Web API key проекта `travel-edu-app`.
4. Убедитесь, что `ADMIN_EMAIL` равен `psnkzeducation@gmail.com`.
5. Запустите новый production deployment.

## Проверка после деплоя

1. Откройте главную страницу в режиме инкогнито и пройдите тест как кандидат.
2. Проверьте обязательное согласие на обработку данных.
3. Войдите в админку по email и паролю.
4. Создайте тест, скопируйте короткую ссылку и откройте ее в другом браузере.
5. Завершите тест и убедитесь, что в отчете появилась ровно одна строка.
6. Проверьте создание черновика, публикацию, копирование, архив и резервную копию.

## Позже

Перед внешним массовым запуском стоит определить срок хранения персональных данных, добавить удаление данных по регламенту и лимит запросов к `/api/tests`.
