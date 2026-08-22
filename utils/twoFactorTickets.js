'use strict';

const crypto = require('crypto');
const NodeCache = require('node-cache');

/**
 * One-time, short-lived tickets for the 2FA continuation flow.
 *
 * Why: after a successful password sign-in the frontend intentionally ends the
 * Supabase session until the second factor is verified, so /2fa/challenge and
 * /2fa/verify cannot rely on a bearer token. Trusting a body-supplied user_id
 * instead allowed unauthenticated OTP spam against any store user. Tickets are
 * minted only by an authenticated endpoint immediately after password proof,
 * are bound to (user, store), expire in 5 minutes, and are consumed once.
 */

const TICKET_TTL_SECONDS = 5 * 60;
const MAX_TICKETS_PER_USER = 5;

const cache = new NodeCache({
  stdTTL: TICKET_TTL_SECONDS,
  useClones: false,
  checkperiod: 30
});

function issueTicket(userId, storeId) {
  if (!userId || !storeId) return null;

  // Bound live tickets per user+store to prevent unbounded memory growth.
  const owned = cache.keys().filter((key) => key.endsWith(`:${userId}:${storeId}`));
  if (owned.length >= MAX_TICKETS_PER_USER) {
    const oldest = owned
      .map((key) => ({ key, ts: cache.get(key)?.issuedAt || 0 }))
      .sort((a, b) => a.ts - b.ts)
      .slice(0, owned.length - MAX_TICKETS_PER_USER + 1);
    for (const entry of oldest) cache.del(entry.key);
  }

  const ticket = crypto.randomBytes(32).toString('hex');
  cache.set(ticket, { userId, storeId, issuedAt: Date.now() });
  return ticket;
}

// Resolve the user bound to a ticket without consuming it (store-scoped).
function resolveTicketUser(ticket, storeId) {
  if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket)) return null;
  const data = cache.get(ticket);
  if (!data) return null;
  if (storeId && data.storeId !== storeId) return null;
  return data.userId;
}

// Burn the ticket once the second factor has been verified successfully.
function burnTicket(ticket) {
  if (typeof ticket === 'string') cache.del(ticket);
}

module.exports = { issueTicket, resolveTicketUser, burnTicket };
