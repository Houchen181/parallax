export declare const TEST_KEY: string

export interface MockServer {
  port: number
  origin: string
  control: {
    /** What the next authorize request does: approve, deny, or approve without plan usage. */
    next: 'approve' | 'deny' | 'no-plan'
    authorizeLog: Array<Record<string, string>>
    revoked: string[]
  }
  close(): Promise<void>
}

export declare function startMockServer(options?: { port?: number; tokenTtl?: number }): Promise<MockServer>
