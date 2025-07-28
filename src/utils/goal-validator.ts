import { z } from "zod";
import { HRCCore } from "../modules/hrc";

export const goalSchema = z
  .object({
    id: z.string().uuid().optional(),
    userId: z.string().min(1),
    title: z.string().min(3).max(200),
    description: z.string().min(1).max(4000),
    targetDate: z.preprocess(
      (val: unknown) => (val ? new Date(val as string) : undefined),
      z.date().optional(),
    ),
    status: z
      .enum(["active", "completed", "paused", "cancelled"])
      .default("active"),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
    progress: z.number().int().min(0).max(100).default(0),
    createdAt: z.preprocess(
      (val: unknown) => (val ? new Date(val as string) : new Date()),
      z.date().optional(),
    ),
    updatedAt: z.preprocess(
      (val: unknown) => (val ? new Date(val as string) : new Date()),
      z.date().optional(),
    ),
  })
  .strict();

export type GoalInput = z.infer<typeof goalSchema>;

export async function validateGoalInput(
  input: unknown,
  hrc?: HRCCore,
): Promise<GoalInput> {
  const parsed = goalSchema.parse(input);

  if (hrc) {
    const titleCheck = await hrc.validate(parsed.title, {});
    const descriptionCheck = await hrc.validate(parsed.description, {});
    if (!titleCheck.success || !descriptionCheck.success) {
      throw new Error("Unsafe goal content detected");
    }
  }

  return parsed;
}
