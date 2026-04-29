import type { SlotRole } from "@/terminal/terminal-pool-types";
import type { TerminalSlot } from "@/terminal/terminal-slot";

export class TerminalPoolState {
	private readonly slots: TerminalSlot[] = [];
	private readonly slotRoles = new Map<TerminalSlot, SlotRole>();
	private readonly roleTimestamps = new Map<TerminalSlot, number>();
	private readonly taskSlots = new Map<string, TerminalSlot>();

	getSlots(): readonly TerminalSlot[] {
		return this.slots;
	}

	addSlot(slot: TerminalSlot, role: SlotRole = "FREE"): void {
		this.slots.push(slot);
		this.setRole(slot, role);
	}

	getRole(slot: TerminalSlot): SlotRole {
		return this.slotRoles.get(slot) ?? "FREE";
	}

	setRole(slot: TerminalSlot, role: SlotRole): void {
		this.slotRoles.set(slot, role);
		this.roleTimestamps.set(slot, Date.now());
	}

	getSlotForTask(taskId: string): TerminalSlot | null {
		return this.taskSlots.get(taskId) ?? null;
	}

	hasSlotForTask(taskId: string): boolean {
		return this.taskSlots.has(taskId);
	}

	assignTaskSlot(taskId: string, slot: TerminalSlot): void {
		this.taskSlots.set(taskId, slot);
	}

	removeTaskSlot(taskId: string): TerminalSlot | null {
		const slot = this.taskSlots.get(taskId) ?? null;
		this.taskSlots.delete(taskId);
		return slot;
	}

	removeTaskSlotForSlot(slot: TerminalSlot): string | null {
		for (const [taskId, taskSlot] of this.taskSlots.entries()) {
			if (taskSlot === slot) {
				this.taskSlots.delete(taskId);
				return taskId;
			}
		}
		return null;
	}

	findOldestSlotByRole(role: SlotRole): TerminalSlot | null {
		let oldest: TerminalSlot | null = null;
		let oldestTime = Number.POSITIVE_INFINITY;
		for (const slot of this.slots) {
			if (this.getRole(slot) === role) {
				const timestamp = this.getTimestamp(slot);
				if (timestamp < oldestTime) {
					oldestTime = timestamp;
					oldest = slot;
				}
			}
		}
		return oldest;
	}

	findNewestSlotByRole(role: SlotRole): TerminalSlot | null {
		let newest: TerminalSlot | null = null;
		let newestTime = -1;
		for (const slot of this.slots) {
			if (this.getRole(slot) === role) {
				const timestamp = this.getTimestamp(slot);
				if (timestamp > newestTime) {
					newestTime = timestamp;
					newest = slot;
				}
			}
		}
		return newest;
	}

	prepareSlotReplacement(slot: TerminalSlot): number | null {
		const index = this.slots.indexOf(slot);
		if (index === -1) {
			return null;
		}
		this.clearSlotMetadata(slot);
		return index;
	}

	replaceSlotAt(index: number, slot: TerminalSlot, role: SlotRole = "FREE"): void {
		this.slots[index] = slot;
		this.setRole(slot, role);
	}

	clear(): void {
		this.slots.length = 0;
		this.slotRoles.clear();
		this.roleTimestamps.clear();
		this.taskSlots.clear();
	}

	private getTimestamp(slot: TerminalSlot): number {
		return this.roleTimestamps.get(slot) ?? 0;
	}

	private clearSlotMetadata(slot: TerminalSlot): void {
		this.slotRoles.delete(slot);
		this.roleTimestamps.delete(slot);
		this.removeTaskSlotForSlot(slot);
	}
}
