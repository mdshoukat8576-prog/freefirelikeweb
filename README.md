# freefirelikeweb — Free Fire Auto Like Storefront

This build uses manual QR/UPI payment. Razorpay is not required.

## 1. Setup

```bash
npm install
```

Copy `.env.example` to `.env` and set:

- `UPI_ID`
- `PAYMENT_ACCOUNT_NAME`
- `PAYMENT_QR_PATH`
- `ADMIN_KEY`
- `BOT_TOKEN`
- `ADMIN_CHAT_ID`

## 2. Telegram admin bot

**Security:** never publish your bot token or commit `.env` to GitHub.

1. Create/open your Telegram bot with BotFather.
2. Start the bot yourself and send `/start`.
3. The bot replies with your chat ID.
4. Put that value into `ADMIN_CHAT_ID`.
5. Put your bot token into `BOT_TOKEN`.
6. Restart the server.

When a customer submits payment proof, the bot sends the order to the admin chat with:

- customer Telegram username (if supplied)
- Free Fire UID
- server
- plan
- amount
- UTR
- payment screenshot
- order ID
- inline **ACCEPT / REJECT / PROCESSING / COMPLETED** buttons

The website order status updates when an admin presses a button.

## 3. Owner Telegram

`ADMIN_TELEGRAM` controls the website's direct Telegram support button. The customer can open the owner's DM with the order details pre-filled.

## 4. Start

```bash
npm start
```

The bot runs alongside the Express server using Telegram long polling.


## If Telegram DM is not arriving
1. Open your bot in Telegram and press **Start**, then send `/start`.
2. Copy the numeric chat ID returned by the bot.
3. In the SAME `FF_GLORY_STORE` folder as `server.js`, create a file named exactly `.env` (not `.env.txt`).
4. Set `BOT_TOKEN` to a newly regenerated BotFather token and `ADMIN_CHAT_ID` to the numeric ID.
5. Restart `npm start`. The terminal must show `[Telegram] Config loaded...` and `[Telegram] Startup test message sent.`
6. Submit a payment proof. The bot will send the order and screenshot with Accept/Reject/Processing/Completed buttons.

Do not put the bot token in GitHub or share it. If a token has been exposed, revoke it in BotFather and generate a new one.


## Telegram configuration troubleshooting

The server now loads `.env` from the same folder as `server.js`. If `.env` is missing, this packaged build also reads `.env.example` as a fallback. On Windows, make sure File name extensions are enabled so you do not accidentally create `.env.txt`.

When starting the server, the first line should say either `[ENV] Loaded from .env` or `[ENV] Loaded from .env.example`. Then the Telegram bot should report whether it connected. Never share your bot token; if it has been exposed, regenerate it with BotFather.
>>>>>>> 4af99eb (feat: complete FFLike website transformation - mobile circular dock, 3D animations, custom UPI QR, and SEO suite)
