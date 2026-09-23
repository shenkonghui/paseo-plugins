import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const relativePath = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "Path must stay inside the project root",
  });

export const wikiSources = defineSettings({
  id: "sources",
  scope: "host",
  version: 1,
  schema: z.object({
    // projectId -> directories relative to the project root
    directories: z.record(z.string(), z.array(relativePath)).default({}),
  }),
});

export const listDirectoriesRpc = defineRpc({
  name: "wiki.list-directories",
  input: z.object({ rootPath: z.string().min(1) }),
  output: z.object({ directories: z.array(z.string()) }),
});

export const listFilesRpc = defineRpc({
  name: "wiki.list-files",
  input: z.object({
    rootPath: z.string().min(1),
    directories: z.array(relativePath),
  }),
  output: z.object({
    files: z.array(z.object({ directory: z.string(), path: z.string(), name: z.string() })),
  }),
});

export const readFileRpc = defineRpc({
  name: "wiki.read-file",
  input: z.object({ rootPath: z.string().min(1), path: relativePath }),
  output: z.object({ content: z.string(), truncated: z.boolean() }),
});
