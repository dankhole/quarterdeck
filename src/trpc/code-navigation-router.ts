import {
	codeNavigationHoverResponseSchema,
	codeNavigationRequestSchema,
	codeNavigationResponseSchema,
	codeNavigationScopeSchema,
	codeNavigationStatusSchema,
} from "../core/api/code-navigation";
import { projectProcedure, t } from "./app-router-init";

export const codeNavigationRouter = t.router({
	status: projectProcedure
		.input(codeNavigationScopeSchema)
		.output(codeNavigationStatusSchema)
		.query(({ ctx, input }) => ctx.codeNavigationApi.status(ctx.projectScope, input)),
	definition: projectProcedure
		.input(codeNavigationRequestSchema)
		.output(codeNavigationResponseSchema)
		.mutation(({ ctx, input }) => ctx.codeNavigationApi.definition(ctx.projectScope, input)),
	references: projectProcedure
		.input(codeNavigationRequestSchema)
		.output(codeNavigationResponseSchema)
		.mutation(({ ctx, input }) => ctx.codeNavigationApi.references(ctx.projectScope, input)),
	hover: projectProcedure
		.input(codeNavigationRequestSchema)
		.output(codeNavigationHoverResponseSchema)
		.mutation(({ ctx, input }) => ctx.codeNavigationApi.hover(ctx.projectScope, input)),
});
