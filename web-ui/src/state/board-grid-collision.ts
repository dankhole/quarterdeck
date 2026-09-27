import { type CollisionDetection, closestCorners, pointerWithin } from "@dnd-kit/core";

// Prefer cards over their containing section. The sortable keyboard sensor aligns
// target top-left corners; using that anchor also handles a wide, collapsed Trash.
export const boardGridCollision: CollisionDetection = (args) => {
	const collisions = pointerWithin({
		...args,
		pointerCoordinates: args.pointerCoordinates ?? { x: args.collisionRect.left + 1, y: args.collisionRect.top + 1 },
	});
	if (!collisions.length && !args.pointerCoordinates) return closestCorners(args);
	const cards = collisions.filter((collision) => !["in_progress", "review", "trash"].includes(String(collision.id)));
	return cards.length ? cards : collisions;
};
