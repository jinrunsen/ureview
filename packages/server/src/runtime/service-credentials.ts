import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import type { Context } from "@deepseek-ai/cordis";

export class ServiceCredentialProvider extends LocalCredentialProvider {
  constructor(ctx: Context, config: { dshHome: string; resolveKey: (ref: string) => Promise<string | undefined> }) {
    super(ctx, { dshHome: config.dshHome });
    this.resolveKey = config.resolveKey;
  }
  private readonly resolveKey: (ref: string) => Promise<string | undefined>;
  override async resolve(ref: CredentialRef) {
    const value = await this.resolveKey(ref);
    return value === undefined ? super.resolve(ref) : { value, source: "service-database" };
  }
  override async describe(ref: CredentialRef) {
    const value = await this.resolveKey(ref);
    return value === undefined ? super.describe(ref) : { configured: true, source: "service-database", writable: false };
  }
}
