import type { Workspace } from "@/lib/domain";
export type Mutate = (
  action: Record<string, unknown>,
  success?: string,
) => Promise<boolean>;
export type ViewProps = {
  data: Workspace;
  mutate: Mutate;
  busy: boolean;
  error?: string;
};
