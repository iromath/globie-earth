// The rendered heading and body for one notification - the server's copy of the
// app's own notificationText().
//
// This file is a *twin*, kept in step by hand, of the per-kind switch in
// src/components/NotificationsProvider.tsx (notificationText, the R2 copy). It
// exists for one reason: the push dispatcher (pushDispatcher.ts, 2d) has to hand
// sendPush (pushSender.ts, 2d.1) an already-rendered `title`/`body`, and the MCP
// build cannot import that component - it is React, it mounts a provider, and it
// reaches Vite's `import.meta.env` through src/lib/site.ts, none of which is
// valid input to a NodeNext compile (infra/mcp/tsconfig.json pins `rootDir` to
// infra/mcp/src). So the copy is written twice rather than shared.
//
// The provider is the source of truth. If the copy changes - a kind reworded, a
// language added, a `body_params` key read differently - change *both*, and
// change them together: nothing here is tested against the app, and the only
// thing keeping them equal is that they are read side by side.
//
// The row stores a `title_key` and a `body_params` (migration `251`), but - like
// the app - this reads the copy off `kind` and `body_params`, not the key: the
// plan leaves the key's rendering to the client, and the server twin renders it
// the same way, so a push says exactly what the in-app toast says.

/** One string out of body_params, so a numeric delta still renders (as the app does). */
function param(row: { body_params: Record<string, unknown> | null }, key: string): string {
  const value = row.body_params?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/**
 * The copy for one row, in the recipient's language. 'en' unless told exactly
 * 'en', matching the app's own `const en = lang === 'en'`. An unknown kind still
 * says something rather than nothing.
 */
export function notificationText(
  row: { kind: string; body_params: Record<string, unknown> | null },
  lang: string | null | undefined,
): { title: string; body: string } {
  const en = lang === 'en';
  const species = param(row, 'species_name');
  const author = param(row, 'author');
  const delta = param(row, 'delta') || '0';

  switch (row.kind) {
    case 'media_pending':
      return en
        ? { title: 'Photo received', body: `${species || 'Your photo'} is being reviewed.` }
        : { title: 'ได้รับภาพแล้ว', body: `${species || 'ภาพของคุณ'} อยู่ระหว่างการตรวจ` };
    case 'media_approved':
      return en
        ? {
            title: 'Photo published',
            body: `${species || 'Your photo'} is now in the Field Guide.`,
          }
        : { title: 'เผยแพร่แล้ว', body: `${species || 'ภาพของคุณ'} ปรากฏในคู่มือภาคสนามแล้ว` };
    case 'media_rejected':
      return en
        ? { title: 'Photo not accepted', body: `${species || 'Your photo'} was not added this time.` }
        : { title: 'ไม่ได้รับเลือก', body: `${species || 'ภาพของคุณ'} ไม่ถูกเพิ่มในครั้งนี้` };
    case 'points_awarded':
      return en
        ? { title: `+${delta} leaf tokens`, body: 'Your contribution earned a reward.' }
        : { title: `+${delta} เหรียญใบไม้`, body: 'ผลงานของคุณได้รับรางวัล' };
    case 'discussion_message':
      return en
        ? { title: 'New reply', body: `${author || 'Someone'} replied to your contribution.` }
        : { title: 'มีการตอบกลับใหม่', body: `${author || 'มีบางคน'} ตอบกลับภาพที่คุณร่วมส่ง` };
    case 'question':
      return en
        ? { title: 'New question', body: `${author || 'Someone'} asked about your contribution.` }
        : { title: 'มีคำถามใหม่', body: `${author || 'มีบางคน'} ถามเกี่ยวกับภาพที่คุณร่วมส่ง` };
    default:
      return en
        ? { title: 'Notification', body: 'You have a new update.' }
        : { title: 'การแจ้งเตือน', body: 'คุณมีอัปเดตใหม่' };
  }
}
