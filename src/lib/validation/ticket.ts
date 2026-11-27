import { z } from "zod";
import { tooLong, tooMany } from "@/lib/validation/text";

export const ticketStatusValues = ["OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED"] as const;
export const ticketPriorityValues = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export const ticketTypeValues = ["PRODUCT_SUPPORT", "DEMO", "INSTALLATION", "TRAINING", "OTHER"] as const;

export const createTicketSchema = z.object({
  companyId: z.string().max(100, tooLong(100)).min(1, "Select a company"),
  contactId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  companyProductId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  title: z.string().trim().max(500, tooLong(500)).min(2, "Title is required"),
  description: z.string().trim().max(20000, tooLong(20000)).optional().or(z.literal("")),
  ticketType: z.enum(ticketTypeValues).default("PRODUCT_SUPPORT"),
  priority: z.enum(ticketPriorityValues).default("MEDIUM"),
  assignedToUserId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const updateTicketStatusSchema = z.object({
  ticketId: z.string().max(100, tooLong(100)).min(1),
  status: z.enum(ticketStatusValues),
});

export const updateTicketPrioritySchema = z.object({
  ticketId: z.string().max(100, tooLong(100)).min(1),
  priority: z.enum(ticketPriorityValues),
});

export const assignTicketSchema = z.object({
  ticketId: z.string().max(100, tooLong(100)).min(1),
  userId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
});

export const addTicketCommentSchema = z.object({
  ticketId: z.string().max(100, tooLong(100)).min(1),
  body: z.string().trim().max(200000, tooLong(200000)).min(1, "Comment can't be empty"),
});

export const bulkUpdateTicketsSchema = z.object({
  ticketIds: z.array(z.string().max(100, tooLong(100)).min(1)).min(1, "Select at least one ticket").max(1000, tooMany(1000)),
  /** "" leaves the field alone; "unassign" clears the agent. */
  assignedToUserId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  status: z.enum(ticketStatusValues).optional().or(z.literal("")),
  priority: z.enum(ticketPriorityValues).optional().or(z.literal("")),
});
