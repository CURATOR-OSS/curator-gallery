# Curator

A free, open-source Chrome extension for the **Gallery** in EA SPORTS FC 27 Ultimate Team. It runs inside the official web app.

> **Disclaimer:** Curator is an **unofficial** tool, not affiliated with or endorsed by Electronic Arts. EA SPORTS FC and Ultimate Team are trademarks of Electronic Arts Inc. Using third-party tools in the web app is against EA's rules and can lead to penalties. Use it at your own risk. **Buy cart** is the riskiest feature: it stays off until you use it and asks you to accept a warning every time.

## Features

- **Read set:** shows every card in a set, the ones you have and the ones you're missing, with each card's points.
- **Tag bonuses:** calculates all 20 Gallery tags with their levels and the 10-tag cap, same result as the game.
- **Best lineup:** picks the combination of your cards with the most points, bonuses included.
- **First Owner:** detects the cards you packed yourself; you can also mark them by hand or assume a %.
- **Prices:** fut.gg prices for the cards you're missing, plus a 🔍 to look up a single card on the EA market.
- **Purchase planner:** the cheapest cards to buy to reach a grade (D to S), counting what you lose if you resell them (EA's 5%).
- **All sets:** a table with your grade, score, next grade, cost and coins per token for every set; an overview with your Gallery level, sets ready to grade and the cheapest next tokens; and a budget tool ("I have X coins" / "I want X tokens").
- **Delivered grade:** the grade you've already claimed in the game, read from EA when possible, or marked by hand.
- **Best buys and cart:** the cards that add the most Gallery points per coin, and the exact effect of your cart on each set.
- **Buy cart (optional):** buys the cart one card at a time with pauses, a price cap, a coin cap and daily/hourly limits. It stops on any EA warning. After buying it can leave cards in "Unassigned", send them to the club or transfer list, or list them for sale.

It doesn't sell, submit SBCs or open packs, and nothing runs in the background: it only acts when you press a button.

## Privacy

Curator has no server and no tracking. Everything it remembers stays in your own browser. The only outside request is fut.gg's public price list.

## Install

1. Download and unzip the project.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped folder.
5. Open the Ultimate Team web app and sign in. The **Curator** button appears at the bottom right.

## List of sets

The extension ships with 196 sets (`sets.js`, the same as `community/sets.json`). New or changed sets can be added from **Sets…** in the extension, or imported from an updated `community/sets.json`. To contribute, see `CONTRIBUTING.md`.

## License

MIT. See `LICENSE`.
