import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Private documents, originals, revisions, and import jobs all have an owner.
// A published snapshot alone uses a separate, unguessable public partition.
export const documents = sqliteTable("documents", {
  pk: text("pk").notNull(),
  sk: text("sk").notNull(),
  value: text("value").notNull(),
  revision: integer("revision").notNull(),
}, table => [primaryKey({ columns: [table.pk, table.sk] })]);
export const insertDocumentSchema = createInsertSchema(documents);
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documents.$inferSelect;
export type Work = {
  id: string; title: string; author: string;
  kind: "poetry" | "story" | "essay" | "other";
  body: string; collection: string;
  theme: "forest" | "clay" | "linen" | "night";
  archived: boolean; version: number;
  versionName?: string;
  layout?: {lineHeight:number;stanzaGap:"original"|"compact"|"airy";align:"left"|"center"|"right";pageMode:"manual"|"stanza"};
  derivedFrom?: {id:string;version:number;title:string};
  createdAt: string; updatedAt: string;
  source?: { key: string; platform: string; url: string; fetchedAt: string; original: string; hash: string };
  example?: boolean; shareToken?: string;
};
