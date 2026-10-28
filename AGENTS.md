<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Project rules
- The racing game runs on a plain 2D canvas engine in `src/game/` (simulation + rendering), with React only for HUD, touch controls and menus — keeps the frame loop out of React renders for smooth mobile play.
- Car art is top-down transparent PNG sprites in `src/assets/`; the engine reads each sprite's aspect ratio at runtime, so swapping art needs no code changes.
- Engine sound is pitch-matched granular playback of one real full-throttle recording (`src/game/audio.ts`), with a gearbox model driving rpm — avoids the "toy car" effect of pitch-shifting a short loop.
- Traffic passability rules live in `src/game/traffic.ts` (pure, unit-tested): cars may never line up across every lane, so the player always has a way through.
