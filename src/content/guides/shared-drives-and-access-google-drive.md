---
title: Shared drives and access limits in Google Drive
description: Use shared drives, limited access folders, approvals, and access checks
featured: false
sources:
  - id: "1"
    title: "Store & share files or folders with shared drives — Computer"
    url: "https://support.google.com/drive/answer/7286514?hl=en&co=GENIE.Platform%3DDesktop"
    note: "Google Drive Help Center — what shared drives are and member roles."
  - id: "2"
    title: "Move files & folders into shared drives — Computer"
    url: "https://support.google.com/drive/answer/13045066?hl=en&co=GENIE.Platform%3DDesktop"
    note: "Google Drive Help Center — moving My Drive content into shared drives and how access changes."
  - id: "3"
    title: "Learn about limited access to files and folders in Google Drive — Computer"
    url: "https://support.google.com/drive/answer/14254362?hl=en&co=GENIE.Platform%3DDesktop"
    note: "Google Drive Help Center — Limit access on folders, who can manage it, and grayed-out folders."
  - id: "4"
    title: "Get approvals on files in Google Drive"
    url: "https://support.google.com/drive/answer/10519239?hl=en"
    note: "Google Drive Help Center — lock a file for approval review and unlock it."
  - id: "5"
    title: "View security limitations on Google Drive files"
    url: "https://support.google.com/drive/answer/15697599?hl=en"
    note: "Google Drive Help Center — Security Limitations view in Docs, Sheets, Slides, and Vids."
  - id: "6"
    title: "Learn more about access to Google files — Computer"
    url: "https://support.google.com/drive/answer/16722399?hl=en&co=GENIE.Platform%3DDesktop"
    note: "Google Drive Help Center — You need access messages and requesting access."
---

Shared drives are for team-owned files. Limited access, approvals, and security settings control who can open or change things. For everyday Share / link / stop-sharing steps, see [Share files and folders in Google Drive](/guide/share-files-google-drive).<sup class="guide-fn"><a href="#source-1">1</a></sup>

## Shared drives (overview)

A **shared drive** is a shared space where:<sup class="guide-fn"><a href="#source-1">1</a></sup>

- Members share ownership of the files and folders in it.
- If someone leaves, files they added stay in the shared drive.
- You can still share individual files or folders with a link or invite.

Anyone in your organization can create a shared drive. If you cannot use shared drives, contact your administrator. Shared drives also have limits on items, members, and daily uploads.<sup class="guide-fn"><a href="#source-1">1</a></sup>

### Member roles

| Role | What they can do |
| --- | --- |
| **Manager** | Manage members; upload, edit, move, or delete all files and folders |
| **Content manager** | By default: upload, edit, move, or delete all files |
| **Contributor** | Edit files and upload new ones; cannot move or delete files |
| **Commenter** | Comment only |
| **Viewer** | View only |

<sup class="guide-fn"><a href="#source-1">1</a></sup>

<figure class="guide-media">
  <img
    src="/guides/shared-drives-and-access-google-drive/desktop-1ad790bc.png"
    alt="Shared drive folder list showing a grayed-out limited-access folder"
    width="600"
    loading="lazy"
    decoding="async"
  />
</figure>

## Move files into a shared drive

On a computer, with a work or school account, you can move files and folders from **My Drive** into a shared drive. By default you can move items you own. If your admin allows it, Editors may also move files. You can move a **folder** into a shared drive only if you are a **Manager** of that shared drive.<sup class="guide-fn"><a href="#source-2">2</a></sup>

### How access changes after a move

When content moves into a shared drive:<sup class="guide-fn"><a href="#source-2">2</a></sup>

- People who are not members of the shared drive may lose access.
- Only shared drive members and people who have direct share access can open the file.
- Permissions inherited from parent folders are not copied when you move a child folder.
- If the original owner is in your organization but not a shared drive member, they lose ownership but can still access the file.

### Common limits

- You cannot move folders or files owned by users **outside** your organization.<sup class="guide-fn"><a href="#source-2">2</a></sup>
- Some items cannot move because of permissions, policy, file type, or destination issues. Drive may create **shortcuts** for items that cannot move, and may let you download a CSV list of blocked items with error codes.<sup class="guide-fn"><a href="#source-2">2</a></sup>
- Large folder moves have caps (for example, too many unmovable items in a folder, or a very large total item count).<sup class="guide-fn"><a href="#source-2">2</a></sup>

Managers in a shared drive can also limit access to specific folders so not every member sees everything. See the next section.<sup class="guide-fn"><a href="#source-2">2</a></sup>

## Limited access folders

**Limit access** on a folder so only people you give permission to can open it. Others who can see the parent folder may still see the folder name, but it looks **grayed out** and they cannot open it.<sup class="guide-fn"><a href="#source-3">3</a></sup>

A common pattern: share a main folder with a larger group, then put sensitive files in a subfolder with limited access for a smaller group.<sup class="guide-fn"><a href="#source-3">3</a></sup>

### Turn on Limit access (computer)

1. Open [Google Drive](https://drive.google.com).
2. Right-click the folder.
3. Click **Share** → **Share** → **Settings**.
4. Turn on **Limit access**.
5. Click **Back**.
6. In the share dialog, add or remove people for that folder.<sup class="guide-fn"><a href="#source-3">3</a></sup>

<figure class="guide-media">
  <img
    src="/guides/shared-drives-and-access-google-drive/desktop-7ca524c7.png"
    alt="Share dialog Settings gear for a folder"
    width="600"
    loading="lazy"
    decoding="async"
  />
</figure>

<figure class="guide-media">
  <img
    src="/guides/shared-drives-and-access-google-drive/desktop-521869e7.png"
    alt="Folder settings with Limit access option"
    width="600"
    loading="lazy"
    decoding="async"
  />
</figure>

<figure class="guide-media">
  <img
    src="/guides/shared-drives-and-access-google-drive/desktop-740bb87d.png"
    alt="Share dialog after Limit access, with Access removed notice"
    width="600"
    loading="lazy"
    decoding="async"
  />
</figure>

### Who can manage it

- **My Drive:** Folder owners can turn limited access on or off. If “Editors can change permissions” is on, editors can manage it too.<sup class="guide-fn"><a href="#source-3">3</a></sup>
- **Shared drives:** Managers can turn limited access on or off. Content managers can manage the user list only if managers allow content managers to share folders.<sup class="guide-fn"><a href="#source-3">3</a></sup>

You can turn limited access on only for **folders**. Drive may automatically apply limited access to some files during system updates; you cannot apply it to a single file yourself. To restrict one file, put it in its own limited-access subfolder.<sup class="guide-fn"><a href="#source-3">3</a></sup>

### If a folder looks grayed out

If you cannot open a limited-access folder, you are not on that folder’s permissions list. It appears grayed out. If Drive applied limited access automatically, you might not see the folder at all.<sup class="guide-fn"><a href="#source-3">3</a></sup>

<figure class="guide-media guide-media--phone">
  <img
    src="/guides/shared-drives-and-access-google-drive/desktop-d6f13255.png"
    alt="Mobile file list with a grayed-out limited-access folder"
    width="350"
    loading="lazy"
    decoding="async"
  />
</figure>

Tip: In the share dialog, check both **People with access** and **General access**. The “Access removed” list shows people blocked from a limited folder even if they can open the parent. Group or general access can still override a removal.<sup class="guide-fn"><a href="#source-3">3</a></sup>

## Approvals (lock for review)

When content is ready for review, you can lock a file and ask someone to approve it. While a file is locked, no one can edit it. Unlocking cancels in-progress approvals. Only the owner or someone with **Edit** permission can unlock.<sup class="guide-fn"><a href="#source-4">4</a></sup>

To unlock on a computer:<sup class="guide-fn"><a href="#source-4">4</a></sup>

1. Go to [Google Drive](https://drive.google.com).
2. Find the file.
3. Right-click → **Unlock**.

## Security limitations

In **Google Docs, Sheets, Slides, and Vids**, the **Security Limitations** view lists restricted actions in one place and shows whether a restriction comes from the file owner / shared drive manager or from an organization policy.<sup class="guide-fn"><a href="#source-5">5</a></sup>

Owners and shared drive managers may disable download, copy, print, and email, or limit who sharing is allowed to. Admins can also set organization policies (for example DLP or trusted domains) that do the same kinds of things.<sup class="guide-fn"><a href="#source-5">5</a></sup>

If an action is blocked, check that view first before assuming Drive is broken.

## “You need access”

If Docs, Sheets, Slides, Vids, or Forms shows **You need access**, you do not have permission to view the file.<sup class="guide-fn"><a href="#source-6">6</a></sup>

Access levels the owner can grant:<sup class="guide-fn"><a href="#source-6">6</a></sup>

- **Viewer** — open, no edits or comments
- **Commenter** — comments and suggestions, no content edits
- **Editor** — change the file, manage suggestions, comment

### Request access

1. On the “You need access” message, click **Request access**.
2. Optionally explain why you need it.
3. Click **Send request**.<sup class="guide-fn"><a href="#source-6">6</a></sup>

The owner gets an email with your account, the file, your message, and an option to notify you. You may get an approval or denial email—or nothing if the request is still pending or was denied without notice. Try opening the file again later.<sup class="guide-fn"><a href="#source-6">6</a></sup>

Also check:<sup class="guide-fn"><a href="#source-6">6</a></sup>

- You are signed into the Google Account the file was shared with.
- If you have several accounts, switch to the right one.
- Work/school policies may block sharing outside the organization.

If you only have Viewer or Commenter access, you cannot share the file yourself, but you can help someone else by starting a share request for them from **Share** on the file.<sup class="guide-fn"><a href="#source-6">6</a></sup>

## Related guides

- [Share files and folders in Google Drive](/guide/share-files-google-drive)
- [Organize files in Google Drive](/guide/organize-files-google-drive)
- [Find files in Google Drive](/guide/find-files-google-drive)

If you still cannot open something you should have access to, submit a Help form so staff can follow up.
