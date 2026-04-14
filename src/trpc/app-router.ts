// Defines the typed TRPC boundary between the browser and the local runtime.
// Keep request and response contracts plus workspace-scoped procedures here,
// and delegate domain behavior to runtime-api.ts and lower-level services.
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { z } from "zod";
import {
	runtimeCommandRunRequestSchema,
	runtimeCommandRunResponseSchema,
	runtimeConfigResponseSchema,
	runtimeConfigSaveRequestSchema,
	runtimeDebugResetAllStateResponseSchema,
	runtimeHookIngestRequestSchema,
	runtimeHookIngestResponseSchema,
	runtimeMigrateTaskWorkingDirectoryRequestSchema,
	runtimeMigrateTaskWorkingDirectoryResponseSchema,
	runtimeOpenFileRequestSchema,
	runtimeOpenFileResponseSchema,
	runtimeProjectAddRequestSchema,
	runtimeProjectAddResponseSchema,
	runtimeProjectDirectoryPickerResponseSchema,
	runtimeProjectRemoveRequestSchema,
	runtimeProjectRemoveResponseSchema,
	runtimeProjectReorderRequestSchema,
	runtimeProjectReorderResponseSchema,
	runtimeProjectsResponseSchema,
	runtimeShellSessionStartRequestSchema,
	runtimeShellSessionStartResponseSchema,
	runtimeTaskSessionInputRequestSchema,
	runtimeTaskSessionInputResponseSchema,
	runtimeTaskSessionStartRequestSchema,
	runtimeTaskSessionStartResponseSchema,
	runtimeTaskSessionStopRequestSchema,
	runtimeTaskSessionStopResponseSchema,
} from "../core/api-contract";
import { t, workspaceProcedure } from "./app-router-init";
import { workspaceRouter } from "./workspace-procedures";

// Re-export context types for consumers.
export type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router-context";

const runtimeRouter = t.router({
	getConfig: t.procedure.output(runtimeConfigResponseSchema).query(async ({ ctx }) => {
		return await ctx.runtimeApi.loadConfig(ctx.workspaceScope);
	}),
	saveConfig: t.procedure
		.input(runtimeConfigSaveRequestSchema)
		.output(runtimeConfigResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.runtimeApi.saveConfig(ctx.workspaceScope, input);
		}),
	startTaskSession: workspaceProcedure
		.input(runtimeTaskSessionStartRequestSchema)
		.output(runtimeTaskSessionStartResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.runtimeApi.startTaskSession(ctx.workspaceScope, input);
		}),
	stopTaskSession: workspaceProcedure
		.input(runtimeTaskSessionStopRequestSchema)
		.output(runtimeTaskSessionStopResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.runtimeApi.stopTaskSession(ctx.workspaceScope, input);
		}),
	sendTaskSessionInput: workspaceProcedure
		.input(runtimeTaskSessionInputRequestSchema)
		.output(runtimeTaskSessionInputResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.runtimeApi.sendTaskSessionInput(ctx.workspaceScope, input);
		}),
	startShellSession: workspaceProcedure
		.input(runtimeShellSessionStartRequestSchema)
		.output(runtimeShellSessionStartResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.runtimeApi.startShellSession(ctx.workspaceScope, input);
		}),
	runCommand: workspaceProcedure
		.input(runtimeCommandRunRequestSchema)
		.output(runtimeCommandRunResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.runtimeApi.runCommand(ctx.workspaceScope, input);
		}),
	resetAllState: t.procedure.output(runtimeDebugResetAllStateResponseSchema).mutation(async ({ ctx }) => {
		return await ctx.runtimeApi.resetAllState(ctx.workspaceScope);
	}),
	setLogLevel: t.procedure
		.input(z.object({ level: z.enum(["debug", "info", "warn", "error"]) }))
		.output(z.object({ ok: z.boolean(), level: z.enum(["debug", "info", "warn", "error"]) }))
		.mutation(({ ctx, input }) => {
			return ctx.runtimeApi.setLogLevel(input.level);
		}),
	flagTaskForDebug: workspaceProcedure
		.input(z.object({ taskId: z.string(), note: z.string().optional() }))
		.output(z.object({ ok: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			return await ctx.runtimeApi.flagTaskForDebug(ctx.workspaceScope, input);
		}),
	openFile: t.procedure
		.input(runtimeOpenFileRequestSchema)
		.output(runtimeOpenFileResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.runtimeApi.openFile(input);
		}),
	migrateTaskWorkingDirectory: workspaceProcedure
		.input(runtimeMigrateTaskWorkingDirectoryRequestSchema)
		.output(runtimeMigrateTaskWorkingDirectoryResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.runtimeApi.migrateTaskWorkingDirectory(ctx.workspaceScope, input);
		}),
});

const projectsRouter = t.router({
	list: t.procedure.output(runtimeProjectsResponseSchema).query(async ({ ctx }) => {
		return await ctx.projectsApi.listProjects(ctx.requestedWorkspaceId);
	}),
	add: t.procedure
		.input(runtimeProjectAddRequestSchema)
		.output(runtimeProjectAddResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectsApi.addProject(ctx.requestedWorkspaceId, input);
		}),
	remove: t.procedure
		.input(runtimeProjectRemoveRequestSchema)
		.output(runtimeProjectRemoveResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectsApi.removeProject(ctx.requestedWorkspaceId, input);
		}),
	pickDirectory: t.procedure.output(runtimeProjectDirectoryPickerResponseSchema).mutation(async ({ ctx }) => {
		return await ctx.projectsApi.pickProjectDirectory(ctx.requestedWorkspaceId);
	}),
	reorder: t.procedure
		.input(runtimeProjectReorderRequestSchema)
		.output(runtimeProjectReorderResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectsApi.reorderProjects(ctx.requestedWorkspaceId, input);
		}),
});

const hooksRouter = t.router({
	ingest: t.procedure
		.input(runtimeHookIngestRequestSchema)
		.output(runtimeHookIngestResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.hooksApi.ingest(input);
		}),
});

export const runtimeAppRouter = t.router({
	runtime: runtimeRouter,
	workspace: workspaceRouter,
	projects: projectsRouter,
	hooks: hooksRouter,
});

export type RuntimeAppRouter = typeof runtimeAppRouter;
export type RuntimeAppRouterInputs = inferRouterInputs<RuntimeAppRouter>;
export type RuntimeAppRouterOutputs = inferRouterOutputs<RuntimeAppRouter>;
