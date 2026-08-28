# St. Cecilia UI components

These are the locally owned building blocks rendered by `/ui`. Import components from the barrel file:

```astro
---
import { Button, MediaCard, type MediaImage } from '../components/ui';
import { iconSquarePlus } from '../scripts/icons';
---

<Button variant="primary" icon={iconSquarePlus}>Create</Button>
<MediaCard
  title="Quick, Draw"
  description="A drawing game."
  images={[{ src: '/images/quick-draw.jpg', alt: 'Quick, Draw preview' }]}
/>
```

Every component imports the shared `styles.css`, which Astro deduplicates and includes only on pages that use the library. Components remain server-rendered; only carousels, chip groups, select menus, action menus, and dialogs add small browser scripts.

## Components

- `Button`, `IconButton`
- `ActionTile`, `MediaCard`
- `Badge`, `ChipGroup`
- `TextField`, `TextareaField`, `SearchField`, `Toggle`
- `SelectMenu`, `ChoiceGroup`
- `ActionMenu`, `Dialog`
- `ToastExample` for the reference page

Application feedback should use the production toast API:

```ts
import { showToast } from '../../scripts/toasts';

showToast({
  kind: 'success',
  icon: 'circle-check',
  title: 'Saved',
  duration: 6000,
});
```

Interactive components dispatch bubbling custom events for page-specific behavior:

- `ChipGroup` and `SelectMenu`: `ui:change`
- `ActionMenu`: `ui:menu-select`

The event value is available at `event.detail.value`.
