export interface DeployConfig {
  accountId?: string;
  envTargets?: string[];
  routingOption?: string;
  customDomain?: string;
  hcaptchaSiteKey?: string;
  pagesProjectName?: string;
  [key: string]: unknown;
}

export declare function loadDeployConfig(configPath?: string): DeployConfig;
export declare function saveDeployConfig(
  values: Record<string, unknown>,
  configPath?: string,
): void;
export declare function validateCfToken(): Promise<void>;
