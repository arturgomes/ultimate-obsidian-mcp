import axios, { AxiosInstance, AxiosError } from "axios";
import https from "https";

export interface GrepMatch {
  line: number;
  text: string;
}

export class ObsidianClient {
  private http: AxiosInstance;

  constructor(baseUrl: string, apiKey: string) {
    this.http = axios.create({
      baseURL: baseUrl,
      headers: { Authorization: `Bearer ${apiKey}` },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10000,
    });
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AxiosError && err.response) {
        const body = err.response.data as { errorCode?: number; message?: string } | undefined;
        const code = body?.errorCode ?? err.response.status;
        const msg = body?.message ?? err.response.statusText;
        throw new Error(`Obsidian API error ${code}: ${msg}`);
      }
      throw err;
    }
  }

  private encodePath(filepath: string): string {
    return filepath
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
  }

  // ── Vault navigation ──────────────────────────────────────────────────────

  async listVault(dirpath?: string): Promise<string[]> {
    return this.call(async () => {
      const path = dirpath
        ? `/vault/${this.encodePath(dirpath.replace(/\/$/, ""))}/`
        : "/vault/";
      const res = await this.http.get<{ files: string[] }>(path);
      return res.data.files;
    });
  }

  async getServerInfo(): Promise<object> {
    return this.call(async () => {
      const res = await this.http.get<object>("/");
      return res.data;
    });
  }

  // ── File existence ────────────────────────────────────────────────────────

  async checkExists(filepath: string): Promise<boolean> {
    try {
      await this.http.head(`/vault/${this.encodePath(filepath)}`);
      return true;
    } catch (err) {
      if (err instanceof AxiosError && err.response?.status === 404) return false;
      // For any other error (network, 500, etc.) — rethrow
      throw err;
    }
  }

  // ── File read ─────────────────────────────────────────────────────────────

  async getFile(filepath: string): Promise<string> {
    return this.call(async () => {
      const res = await this.http.get<string>(`/vault/${this.encodePath(filepath)}`, {
        headers: { Accept: "text/markdown" },
        responseType: "text",
      });
      return res.data;
    });
  }

  async getFileBatch(filepaths: string[]): Promise<{ path: string; content: string }[]> {
    return Promise.all(
      filepaths.map(async (fp) => {
        try {
          const content = await this.getFile(fp);
          return { path: fp, content };
        } catch (err) {
          return { path: fp, content: `Error: ${(err as Error).message}` };
        }
      }),
    );
  }

  // ── File write ────────────────────────────────────────────────────────────

  async createOrUpdateFile(
    filepath: string,
    content: string,
    mode: "append" | "prepend" | "overwrite",
  ): Promise<void> {
    return this.call(async () => {
      const encoded = this.encodePath(filepath);
      const headers = { "Content-Type": "text/markdown" };
      if (mode === "overwrite") {
        await this.http.put(`/vault/${encoded}`, content, { headers });
      } else if (mode === "append") {
        await this.http.post(`/vault/${encoded}`, content, { headers });
      } else {
        // prepend: read + overwrite
        let existing = "";
        try {
          existing = await this.getFile(filepath);
        } catch {
          // file may not exist yet
        }
        await this.http.put(`/vault/${encoded}`, content + existing, { headers });
      }
    });
  }

  /**
   * Write raw bytes to a vault path. The Local REST API accepts any Content-Type on
   * PUT /vault/{filename} (its 400 names text/markdown as correct for *notes*
   * specifically), so images go through this same boundary rather than a second,
   * filesystem-level write path into the vault.
   */
  async putBinary(filepath: string, bytes: Buffer, contentType: string): Promise<void> {
    return this.call(async () => {
      await this.http.put(`/vault/${this.encodePath(filepath)}`, bytes, {
        headers: { "Content-Type": contentType },
      });
    });
  }

  async patchFile(
    filepath: string,
    operation: string,
    targetType: string,
    target: string,
    content: string,
  ): Promise<void> {
    return this.call(async () => {
      await this.http.patch(`/vault/${this.encodePath(filepath)}`, content, {
        headers: {
          "Content-Type": "text/markdown",
          Operation: operation,
          "Target-Type": targetType,
          Target: encodeURIComponent(target),
        },
      });
    });
  }

  async deleteFile(filepath: string): Promise<void> {
    return this.call(async () => {
      await this.http.delete(`/vault/${this.encodePath(filepath)}`);
    });
  }

  async moveFile(sourcePath: string, destPath: string): Promise<void> {
    return this.call(async () => {
      const content = await this.getFile(sourcePath);
      await this.createOrUpdateFile(destPath, content, "overwrite");
      try {
        await this.deleteFile(sourcePath);
      } catch (err) {
        throw new Error(
          `File written to ${destPath} but source delete failed at ${sourcePath}: ${(err as Error).message} — delete manually`,
        );
      }
    });
  }

  async grepFile(filepath: string, pattern: string, useRegex: boolean): Promise<GrepMatch[]> {
    const content = await this.getFile(filepath);
    const lines = content.split("\n");
    const matches: GrepMatch[] = [];

    if (useRegex) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        throw new Error(`Invalid regex: ${(err as Error).message}`);
      }
      lines.forEach((text, i) => {
        if (re.test(text)) matches.push({ line: i + 1, text });
      });
    } else {
      lines.forEach((text, i) => {
        if (text.includes(pattern)) matches.push({ line: i + 1, text });
      });
    }

    return matches;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchSimple(query: string, contextLength = 100): Promise<object[]> {
    return this.call(async () => {
      const res = await this.http.post<object[]>(
        `/search/simple/?query=${encodeURIComponent(query)}&contextLength=${contextLength}`,
      );
      return res.data;
    });
  }

  // ── Periodic notes ────────────────────────────────────────────────────────

  async getPeriodicNote(period: string): Promise<string> {
    return this.call(async () => {
      const res = await this.http.get<string>(`/periodic/${period}/`, {
        responseType: "text",
      });
      return res.data;
    });
  }
}
