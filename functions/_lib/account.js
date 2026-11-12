export const WITHDRAW_CONFIRMATION = "위 내용을 모두 이해했습니다";

export async function revokeGoogleToken(token) {
  if (!token) return false;
  try {
    const res = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteUserAccount(db, userId) {
  const [, , deleted] = await db.batch([
    db.prepare(
      "UPDATE access_codes SET redeemed_by = NULL, redeemed_at = NULL, expires_at = NULL WHERE redeemed_by = ?"
    ).bind(userId),
    db.prepare("DELETE FROM player_state WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ? RETURNING google_refresh_token").bind(userId),
  ]);
  return deleted.results[0]?.google_refresh_token || null;
}
