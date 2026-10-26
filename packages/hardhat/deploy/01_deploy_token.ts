// 01_deploy_token.ts
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
const deployToken: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  await hre.deployments.deploy("FKWToken", { from: deployer, args: [], log: true, autoMine: true });
};
export default deployToken;
deployToken.tags = ["TokenFKW202430552344"];
