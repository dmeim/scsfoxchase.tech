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
- `Card`, `ActionTile`, `MediaCard`
- `Badge`, `ChipGroup`
- `TextField`, `TextareaField`, `SearchField`, `Toggle`
- `SelectField`, `SelectMenu`, `ChoiceGroup`, `SegmentedControl`
- `ProgressTabs` for accessible carousel position controls
- `ActionMenu`, `Dialog`
- `Feedback` for persistent inline status; toasts for transient application feedback
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

Persistent toasts may include one action:

```ts
showToast({
  kind: 'info',
  icon: 'info',
  title: 'Update ready',
  persist: true,
  action: { label: 'Reload', onClick: () => window.location.reload() },
});
```

Interactive components dispatch bubbling custom events for page-specific behavior:

- `ChipGroup`, `SelectMenu`, `SegmentedControl`, and `ProgressTabs`: `ui:change`
- `ActionMenu`: `ui:menu-select`

Client-rendered collections should import `uiClassNames` from `./dom` so their generated cards, buttons, chips, badges, and feedback use the same class contract without copying component styles.

Use `<Card transparent>` (or `uiClassNames.card(extra, { transparent: true })` for client-rendered collections) when content needs the card layout contract without a surface fill.

The event value is available at `event.detail.value`.
