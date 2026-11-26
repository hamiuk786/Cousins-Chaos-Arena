# Security Specification – Cousins Chaos Arena

## 1. Data Invariants
1. **Single Authoritative Room**: Only the verified Host (`isAdmin()`) may create, update, or delete `/rooms/{roomId}` settings, add/edit/remove cousins, write match results, or access recovery checkpoints.
2. **No Score Tampering**: Guests cannot create, modify, or delete `/rooms/{roomId}/matches/{matchId}` documents or room scores.
3. **No Identity Impersonation**: Guests may only claim an unclaimed cousin slot by setting `claimedByUid == request.auth.uid`, and may only unclaim a slot where `existing().claimedByUid == request.auth.uid`.
4. **Strict Schema & Bounds**: Every document enforces exact allowed/required keys (`hasAll` + `hasOnly`), string `.size()` bounds, regex ID validation (`^[a-zA-Z0-9_\-]+$`), bounded arrays (`<= 50`), and server-enforced timestamps (`request.time`).
5. **No PII Exposure**: Room, cousin, and leaderboard documents store only non-PII display names, colors, scores, and Firebase UIDs — never emails, phone numbers, or addresses.
6. **Verified Accounts Only**: All write operations require `request.auth.token.email_verified == true`.

## 2. The "Dirty Dozen" Adversarial Payloads (All Must Fail with PERMISSION_DENIED)
1. **Guest creates a fake Room** (`POST /rooms/fake-room` as non-admin).
2. **Guest injects a MatchResult with forged score 9999** (`POST /rooms/wedding-main/matches/forged` as guest).
3. **Guest alters another player's claimed cousin** (`PATCH /rooms/wedding-main/cousins/c1` setting `claimedByUid: "victim-uid"`).
4. **Guest renames a cousin slot during claim** (`PATCH /rooms/wedding-main/cousins/c1` changing both `claimedByUid` and `name`).
5. **Shadow field injection on Room create** (Admin sends `isVerified: true` extra field).
6. **Oversized document ID poisoning** (`PUT /rooms/wedding-main/cousins/<200-char-id>`).
7. **Unverified email spoof as Host** (`email == "bhoraniyahami@gmail.com"`, `email_verified == false`).
8. **Backdated timestamp forgery** (`createdAt` != `request.time`).
9. **Oversized leaderboard array DoS** (`leaderboard.size() == 51`).
10. **Guest reads Host recovery checkpoints** (`GET /rooms/wedding-main/checkpoints/latest` as guest).
11. **Guest edits completed MatchResult** (`PATCH /rooms/wedding-main/matches/m1` as guest).
12. **Unauthenticated read of cousins or matches** (`GET /rooms/wedding-main/cousins/c1` with `auth == null`).
