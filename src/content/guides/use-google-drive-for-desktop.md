---
title: Use Google Drive for desktop
description: Install and set up Drive for desktop, choose stream or mirror, and fix common sync issues
featured: false
sources:
  - id: "1"
    title: "Use Google Drive for desktop"
    url: "https://support.google.com/drive/answer/10838124?hl=en&co=GENIE.Platform%3DDesktop"
    note: "Google Drive Help Center — install on Windows and macOS, sign in, and key desktop features."
  - id: "2"
    title: "Use Drive for desktop on macOS"
    url: "https://support.google.com/drive/answer/12178485?hl=en"
    note: "Google Drive Help Center — macOS permissions, File Provider streaming, and Finder tips."
  - id: "3"
    title: "Stream & mirror files with Drive for desktop"
    url: "https://support.google.com/drive/answer/13401938?hl=en"
    note: "Google Drive Help Center — streaming vs mirroring and how to switch My Drive sync options."
  - id: "4"
    title: "Customize Drive for desktop settings"
    url: "https://support.google.com/drive/answer/13470231?hl=en"
    note: "Google Drive Help Center — preferences, pause sync, and streamed vs mirrored settings."
  - id: "5"
    title: "Understand your computer and Google storage when using Drive for Desktop"
    url: "https://support.google.com/drive/answer/17196458?hl=en"
    note: "Google Drive Help Center — why local disk space and Google Account storage differ."
  - id: "6"
    title: "Fix problems in Drive for desktop — Computer"
    url: "https://support.google.com/drive/answer/2565956?hl=en&co=GENIE.Platform%3DDesktop"
    note: "Google Drive Help Center — basic sync troubleshooting and common error messages."
  - id: "7"
    title: "Manage Google Drive for desktop: Advanced guide"
    url: "https://support.google.com/drive/answer/16631477?hl=en"
    note: "Google Drive Help Center — advanced controls linked from the main Drive for desktop article."
---

**Google Drive for desktop** puts My Drive and other Drive locations on your Windows PC or Mac so you can open files in File Explorer or Finder.<sup class="guide-fn"><a href="#source-1">1</a></sup>

School and work accounts sometimes need an administrator to install or allow Drive for desktop. If install options are blocked, ask your school tech contact.<sup class="guide-fn"><a href="#source-1">1</a></sup>

Your computer’s free space and your Google Account storage are **not** the same number. See [Computer space vs Google storage](#computer-space-vs-google-storage) below, and [Manage Google storage](/guide/manage-google-storage) for cloud storage.<sup class="guide-fn"><a href="#source-5">5</a></sup>

## Install on Windows

Check that your Windows version is compatible before you start.<sup class="guide-fn"><a href="#source-1">1</a></sup>

1. Download Google Drive for desktop from Google’s download page (**Download for Windows**).<sup class="guide-fn"><a href="#source-1">1</a></sup>
2. Open **GoogleDriveSetup.exe**.
3. Follow the on-screen instructions.<sup class="guide-fn"><a href="#source-1">1</a></sup>

After install, open the Google Drive for desktop menu from the **system tray** at the bottom right. If you do not see it, click the arrow to show hidden icons.<sup class="guide-fn"><a href="#source-1">1</a></sup>

<figure class="guide-media">
  <img
    src="/guides/use-google-drive-for-desktop/desktop-9ab1e961.png"
    alt="Google Drive for desktop on a computer"
    width="400"
    loading="lazy"
    decoding="async"
  />
</figure>

## Install on macOS

Check that your macOS version is supported before you start.<sup class="guide-fn"><a href="#source-1">1</a></sup><sup class="guide-fn"><a href="#source-2">2</a></sup>

1. Download Google Drive for desktop (**Download for Mac**).<sup class="guide-fn"><a href="#source-1">1</a></sup>
2. Open **GoogleDrive.dmg**.
3. Follow the on-screen instructions.<sup class="guide-fn"><a href="#source-1">1</a></sup>

On Mac, the Drive for desktop menu is in the **menu bar** at the top right.<sup class="guide-fn"><a href="#source-1">1</a></sup>

To keep it handy in the Dock: in **Applications**, drag the Google Drive app to the left side of the recently used apps separator line.<sup class="guide-fn"><a href="#source-1">1</a></sup>

<figure class="guide-media">
  <img
    src="/guides/use-google-drive-for-desktop/apple-menu-a2147b16.png"
    alt="Apple menu"
    width="200"
    loading="lazy"
    decoding="async"
  />
</figure>

### macOS permissions and File Provider

If you sync Desktop, Documents, Downloads, removable volumes, or Photos, macOS may ask for privacy permission.<sup class="guide-fn"><a href="#source-2">2</a></sup>

1. Open the **Apple** menu → **System Settings** → **Privacy and Security**.
2. Open **Files and Folders** or **Photos**.
3. Toggle permission for Drive for desktop.<sup class="guide-fn"><a href="#source-2">2</a></sup>

You may need to restart Drive for desktop or your Mac for changes to apply.<sup class="guide-fn"><a href="#source-2">2</a></sup>

On **macOS 12.1 and up**, streaming uses Apple’s **File Provider**. Files appear under **Locations** in the Finder sidebar. You may need to click **Enable** the first time.<sup class="guide-fn"><a href="#source-2">2</a></sup>

With File Provider, dragging items in or out of a Google Drive folder **moves** them (hold **Option** while dragging to copy instead).<sup class="guide-fn"><a href="#source-2">2</a></sup>

## Sign in

1. Open Google Drive for desktop.
2. Click **Get started** → **Sign in** (or **Sign in with the browser**).
3. Sign in to the Google Account you want to use.<sup class="guide-fn"><a href="#source-1">1</a></sup>

You can use up to **4 accounts** at once.<sup class="guide-fn"><a href="#source-1">1</a></sup>

**Add an account:** Drive menu → your profile picture → **Add account** → sign in in the browser → restart Drive for desktop.<sup class="guide-fn"><a href="#source-1">1</a></sup>

**Disconnect an account:** Drive menu → profile picture → **Disconnect account** → **OK**. If a streaming account is disconnected, offline files for that account are removed.<sup class="guide-fn"><a href="#source-1">1</a></sup>

## Stream or mirror My Drive

Drive for desktop can sync My Drive by **streaming** or **mirroring**.<sup class="guide-fn"><a href="#source-3">3</a></sup>

| | Streaming | Mirroring |
| --- | --- | --- |
| **Best when** | You have a reliable internet connection and want to save hard drive space | You need files offline, even when the app is not running |
| **Where files live** | Mainly in the cloud; local space is used when you open or keep files offline | Full copies on your computer **and** in the cloud |
| **Google storage** | Owned files still count toward Google storage | Local copies do not change your Google storage limit |
| **Access** | Usually needs Drive for desktop running; files are online unless made offline | Available online and offline from Finder / File Explorer |

Other notes from Google’s help:<sup class="guide-fn"><a href="#source-3">3</a></sup>

- Shared drives, other computers, and backed-up USB devices can only be **streamed**.
- Local folders or your desktop can only be **mirrored**.
- Some apps (heavy video or photo editing) work better with **mirroring**.

### Choose stream or mirror

1. Open Drive for desktop.
2. Click **Settings** → **Preferences**.
3. On the left, click **Folders from Drive**.
4. Under **My Drive syncing options**, select **Stream files** or **Mirror files**.<sup class="guide-fn"><a href="#source-3">3</a></sup>

If you switch from mirroring to streaming, wait until sync finishes, then you can remove the old mirrored folder. On Windows, quit Drive for desktop before deleting that folder.<sup class="guide-fn"><a href="#source-3">3</a></sup>

## Key features after setup

From the Drive for desktop app you can:<sup class="guide-fn"><a href="#source-1">1</a></sup>

- Check **Sync status** for recent activity.
- Search Drive files with the in-app search (defaults: **Ctrl + Alt + G** on Windows; on macOS, set the hotkey in advanced settings).
- Pause or resume sync.
- Open files from the app folder icon, or from the **Google Drive** location in File Explorer / Finder (**My Drive**, **Shared drives**, and other synced folders).

Google Docs, Sheets, and Slides open in your browser; other files open in their usual desktop apps.<sup class="guide-fn"><a href="#source-1">1</a></sup>

### Pause sync

When sync is paused, Drive for desktop stops background sync of streamed and mirrored folders (and Photos backups). On macOS File Provider, files that are not downloaded are not accessible while paused.<sup class="guide-fn"><a href="#source-4">4</a></sup>

## Computer space vs Google storage

| | What it measures |
| --- | --- |
| **Computer disk space** | Free space on your hard drive (File Explorer or Finder) |
| **Google Account storage** | Shared cloud limit across Drive, Gmail, WhatsApp backups, and Photos |

They rarely match because:<sup class="guide-fn"><a href="#source-5">5</a></sup>

- Streamed files use little local space but still count in the cloud if you own them.
- Mirrored **shared** files can fill your hard drive, but shared files do not use **your** Google storage (with exceptions like making a copy or becoming the owner).
- Gmail, Photos, Trash, and other cloud items use Google storage without appearing as local Drive files.
- After big deletions, cloud totals can take **48–72 hours** to update.

The space tracker in Drive for desktop shows room on your **computer**, not Google Account storage.<sup class="guide-fn"><a href="#source-1">1</a></sup>

## Fix common Drive for desktop problems

If files are not syncing or the app quits suddenly, try these basics first:<sup class="guide-fn"><a href="#source-6">6</a></sup>

1. Confirm your computer meets system requirements.
2. Check your internet connection.
3. Restart Drive for desktop.
4. Restart your computer.
5. Disconnect and reconnect your account.
6. Reinstall Drive for desktop from Google’s download page.

Avoid system cleaner apps (for example CCleaner or Advanced SystemCare) that may edit Drive for desktop configuration and risk data loss.<sup class="guide-fn"><a href="#source-6">6</a></sup>

### Common error messages

- **Low disk space / storage almost full:** Free space on the drive named in the message, exit Drive for desktop, then restart it. You can also unpin offline files.<sup class="guide-fn"><a href="#source-6">6</a></sup>
- **Google Workspace storage is full:** Free cloud storage, or if you do not own the file, ask the owner to free space or transfer ownership.<sup class="guide-fn"><a href="#source-6">6</a></sup>
- **No permission to sync:** Ask the file owner (or shared drive manager) for edit access.<sup class="guide-fn"><a href="#source-6">6</a></sup>
- **Computer won’t allow sync:** Check read/write permissions on the folder (Windows **Properties** → **Security**; macOS **Get Info** → **Sharing and Permissions**). On Mac, also check **Privacy and Security**.<sup class="guide-fn"><a href="#source-6">6</a></sup>
- **Can’t locate folder:** Use the **Locate** prompt to reconnect a moved or renamed Google Drive folder, or stop syncing that directory if you deleted it.<sup class="guide-fn"><a href="#source-6">6</a></sup>
- **Can’t load account:** Check internet, free a drive letter on Windows, disconnect/reconnect, or ask your admin if Drive for desktop is allowed.<sup class="guide-fn"><a href="#source-6">6</a></sup>
- **Lost & Found:** Unsynced files may land in a Lost and Found folder. Move them back into My Drive to retry. Disconnecting the account deletes Lost and Found files for that account.<sup class="guide-fn"><a href="#source-6">6</a></sup>
- **App stops suddenly:** Security or antivirus software may interfere—exclude Drive for desktop from scanning if this repeats.<sup class="guide-fn"><a href="#source-6">6</a></sup>

Copying Google Docs, Sheets, Slides, or Drawings is **not** supported in Drive for desktop—use the browser instead.<sup class="guide-fn"><a href="#source-6">6</a></sup>

For more edge cases, see Google’s full [Fix problems in Drive for desktop](https://support.google.com/drive/answer/2565956?hl=en) article.<sup class="guide-fn"><a href="#source-6">6</a></sup>

## Need more advanced settings?

Google’s [Manage Google Drive for desktop: Advanced guide](https://support.google.com/drive/answer/16631477?hl=en) covers deeper options such as offline access details and photo backups.<sup class="guide-fn"><a href="#source-7">7</a></sup>

For browser Drive issues that are not about the desktop app, see [Fix common Google Drive problems](/guide/fix-google-drive-problems).

If you still cannot sync or install, submit a Help form so staff can follow up.
