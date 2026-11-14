// utils/ticketLimits.js - how big a support ticket may grow
//
// Replies are stored inside the ticket document, which MongoDB limits to 16 MB, and there was no cap: one account could keep
// posting until the ticket could not be saved at all. Customers get a generous cap; staff are not limited by it.

export const MAX_CUSTOMER_REPLIES_PER_TICKET = 200;

/** @returns {boolean} true when a customer can add no more replies to this ticket */
export function ticketIsFull(ticket, isAdmin) {
    if (isAdmin) return false;
    return (ticket?.responses?.length ?? 0) >= MAX_CUSTOMER_REPLIES_PER_TICKET;
}

export default { MAX_CUSTOMER_REPLIES_PER_TICKET, ticketIsFull };
