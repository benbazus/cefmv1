"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRouter = void 0;
const express_1 = __importDefault(require("express"));
const auth_middle_ware_1 = require("../middleware/auth-middle-ware");
const userController = __importStar(require("../controllers/userController"));
const router = express_1.default.Router();
exports.userRouter = router;
router.get('/', auth_middle_ware_1.authMiddleware, auth_middle_ware_1.adminMiddleware, userController.getUsers);
router.post('/', auth_middle_ware_1.authMiddleware, auth_middle_ware_1.adminMiddleware, userController.createUser);
router.put('/:id', auth_middle_ware_1.authMiddleware, auth_middle_ware_1.adminMiddleware, userController.updateUser);
router.delete('/:id', auth_middle_ware_1.authMiddleware, auth_middle_ware_1.adminMiddleware, userController.deleteUser);
router.post('/me', auth_middle_ware_1.authMiddleware, userController.getMe);
