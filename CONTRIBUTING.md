# Helping with the list of sets

The extension ships with a starting list of sets (`sets.js`, the same as `community/sets.json`). When sets change or new ones come out, the community list is updated with what each person sees in the in-game Gallery.

## Add or fix sets

1. In the web app, open **Curator → Sets…** and use the **"Add or edit a set"** form:
   - pick the set to fix, or the club, league or rarity by name for a new one;
   - enter what you see on the set's screen in the game: number of slots and, for each grade (D, C, B, A, S), the score, tokens and reward.
2. Press **"Export my list (.json)"**.
3. Open a *pull request* that adds or changes those sets in `community/sets.json` (or open an *issue* and attach the file).

## Rules

- Only data shown in the game.
- Don't include data from your account (name, club, persona IDs).
- Every change goes through an automatic check (`tools/validate-sets.js`, the same one the extension uses when importing): if a set fails it, the *pull request* isn't accepted.

To run the check on your computer:

```
node tools/validate-sets.js community/sets.json
```
