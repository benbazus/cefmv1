import { Request, Response, NextFunction } from "express";
import * as fileService from "./../services/fileService";
import * as folderService from "../services/folderService";
import * as userService from "../services/userService";
import prisma from "../config/database";
import archiver from "archiver";
import path from "path";
import busboy from "busboy";
import { File, Prisma, User } from "@prisma/client";
import { config } from "../config/config";
import { zipFolder as createZipFolder } from "./../utils/zipFolder";
import { sendSharedLinkEmail } from "../utils/email";
import { decodeFolder } from "../utils/helpers";
import logger from "../utils/logger";
import { getFileById } from "./../services/fileService";
import UAParser from "ua-parser-js";
import mime from "mime-types";

import sharp from "sharp";

import { fromPath } from "pdf2pic";

import fs from "fs-extra";

import { UserInfo } from "../types/express";

const getBaseFolderPath = (email: string): string => {
  return process.env.NODE_ENV === "production"
    ? path.join("/var/www/cefmdrive/storage", email)
    : path.join(process.cwd(), "public", "File Manager", email);
};

export function getUserInfo(req: Request): UserInfo {
  const parser = new UAParser(req.headers["user-agent"]);
  const result = parser.getResult();

  return {
    ipAddress: req.ip || (req.connection.remoteAddress as string),
    userAgent: req.headers["user-agent"] || "",
    operatingSystem: result.os.name || "Unknown",
    browser: result.browser.name || "Unknown",
    deviceType: result.device.type || "unknown",
    deviceModel: result.device.model || "unknown",
    deviceVendor: result.device.vendor || "unknown",
    os: result.os.name || "unknown",
    //browser: result.browser.name || 'unknown'
  };
}

export const handleFileUpload = async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];
    const parentId = req.body.parentId;

    if (!files || files.length === 0) {
      return res.status(400).json({ message: "No files uploaded" });
    }

    const uploadedFiles = files.map((file) => {
      const filePath = file.path
        .replace(config.uploadDir, "")
        .replace(/\\/g, "/");
      const dirPath = path.dirname(filePath);

      // Create directories if they don't exist
      if (dirPath !== "/") {
        fs.mkdirSync(path.join(config.uploadDir, dirPath), { recursive: true });
      }

      return {
        originalName: file.originalname,
        fileName: file.filename,
        path: filePath,
        size: file.size,
        mimeType: file.mimetype,
        parentId: parentId,
      };
    });

    res.status(200).json({
      message: "Files uploaded successfully",
      files: uploadedFiles,
    });
  } catch (error) {
    console.error("Error in file upload:", error);
    res.status(500).json({
      message: "Error uploading files",
      error: (error as Error).message,
    });
  }
};

export const fileUpload = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const bb = busboy({ headers: req.headers });
  const uploadPromises: Promise<any>[] = [];

  const { userId } = req.user as { userId: string };
  const files: Express.Multer.File[] = req.files as Express.Multer.File[];

  let folderId: string | null = null;
  let baseFolderPath = "";
  let fileRelativePath = "";

  bb.on("field", (name, val) => {
    if (name === "folderId") {
      folderId = val;
    }
    if (name === "relativePath") {
      fileRelativePath = val;
    }
  });

  try {
    bb.on("file", async (name, file, info) => {
      const { filename, mimeType } = info;

      const relativePath = fileRelativePath ? fileRelativePath.split("/") : [];
      relativePath.pop();

      if (folderId) {
        const folderResponse = await folderService.getFolderById(folderId);
        if (folderResponse) {
          baseFolderPath = folderResponse.folderPath as string;
        }
      }

      const user = (await userService.getUserById(userId)) as User;

      if (!baseFolderPath) {
        baseFolderPath = path.join(
          process.cwd(),
          "public",
          "File Manager",
          user?.email as string
        );
      }

      const fullPath = path.join(baseFolderPath, ...relativePath, filename);
      const fileUrl = `${
        process.env.PUBLIC_APP_URL
      }/File Manager/${encodeURIComponent(userId)}/${encodeURIComponent(
        filename
      )}`;

      const writeStream = fs.createWriteStream(fullPath);
      file.pipe(writeStream);

      const uploadPromise = new Promise((resolve, reject) => {
        writeStream.on("finish", async () => {
          try {
            const stats = await fs.promises.stat(fullPath);
            const fileData = await prisma.file.create({
              data: {
                name: filename,
                filePath: fullPath,
                fileUrl: fileUrl,
                mimeType: mimeType,
                size: stats.size,
                userId: userId,
                folderId: folderId,
              },
            });
            resolve(fileData);
          } catch (error) {
            reject(error);
          }
        });

        writeStream.on("error", (error) => {
          reject(error);
        });
      });

      uploadPromises.push(uploadPromise);
    });

    bb.on("finish", async () => {
      try {
        const results = await Promise.all(uploadPromises);
        res.json({ message: "Files uploaded successfully", files: results });
      } catch (error) {
        console.error("Error uploading files:", error);
        res.status(500).json({ error: "Error uploading files" });
      }
    });

    req.pipe(bb);
  } catch (error) {
    next(error);
  }
};

export const moveFileItem = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { userId } = req.user as { userId: string };
    const { fileId } = req.params;
    const { newFolderId } = req.body;

    // Fetch the file and ensure it belongs to the user
    const file = await prisma.file.findFirst({
      where: { id: fileId, userId: userId },
    });

    if (!file) {
      return res.status(404).json({
        error:
          "File not found or you do not have permission to move this file.",
      });
    }

    // Fetch the new folder and ensure it belongs to the user
    const newFolder = await prisma.folder.findFirst({
      where: { id: newFolderId, userId: userId },
    });

    if (!newFolder) {
      return res.status(404).json({
        error:
          "Destination folder not found or you do not have permission to access it.",
      });
    }

    // Construct the new file path
    const oldPath = file.filePath as string;
    const newPath = path.join(
      newFolder.folderPath as string,
      path.basename(oldPath)
    );

    // Move the file on the file system
    await fs.move(oldPath, newPath);

    // Construct the new fileUrl
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const newFileUrl = `${
      process.env.PUBLIC_APP_URL
    }/cefmdrive/storage/${encodeURIComponent(
      user.email as string
    )}/${encodeURIComponent(
      path.relative(newFolder.folderPath as string, newPath)
    )}`;

    // Update the file record in the database
    const updatedFile = await prisma.file.update({
      where: { id: fileId },
      data: {
        filePath: newPath,
        folderId: newFolderId,
        fileUrl: newFileUrl,
      },
    });

    // Log file activity
    await prisma.fileActivity.create({
      data: {
        userId,
        fileId: updatedFile.id,
        activityType: "File",
        action: "MOVE FILE",
        filePath: updatedFile.filePath,
        fileSize: updatedFile.size,
        fileType: updatedFile.fileType,
      },
    });

    res.json({ message: "File moved successfully", file: updatedFile });
  } catch (error) {
    console.error("Error moving file:", error);
    next(error);
  }
};

export const moveFile = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { newParentId } = req.body;

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const file = await prisma.file.update({
      where: { id: req.params.id, userId: req.user!.id },
      data: { folderId: newParentId },
    });

    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    // Log file activity
    await prisma.fileActivity.create({
      data: {
        userId: user.id,
        fileId: file.id,
        activityType: "File",
        action: "MOVE FILE",
        filePath: file.filePath,
        fileSize: file.size,
        fileType: file.fileType,
      },
    });

    res.json(file);
  } catch (error) {
    next(error);
  }
};

export const checkPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { password, fileId } = req.body;

    if (!password || !fileId) {
      return res.status(400).json("Missing required password or fileId");
    }

    const uploadedFile = await fileService.checkPassword(password, fileId);
    res.status(201).json(uploadedFile);
  } catch (error) {
    next(error);
  }
};

export const uploadFolder = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { userId } = req.user as { userId: string };
    const { parentFolderId } = req.body;
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };

    if (!files || Object.keys(files).length === 0) {
      return res.status(400).json({ message: "No folder uploaded" });
    }

    const uploadedFolder = await folderService.createFolder(
      userId,
      parentFolderId,
      req.body.folderName
    );

    for (const [path, fileArray] of Object.entries(files)) {
      const file = fileArray[0];
      const pathParts = path.split("/");
      pathParts.pop();

      let currentFolderId = uploadedFolder.id;
      for (const folderName of pathParts) {
        const folder = await folderService.findOrCreateFolder(
          userId,
          currentFolderId,
          folderName
        );
        currentFolderId = folder.id;
      }

      await fileService.uploadFile(userId, currentFolderId, file);
    }

    res.status(201).json(uploadedFolder);
  } catch (error) {
    next(error);
  }
};

export const uploadFiles = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { userId } = req.user as { userId: string };
    const { folderId } = req.body;
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ message: "No files uploaded" });
    }

    const uploadedFiles: File[] = [];
    for (const file of files) {
      const uploadedFile = await fileService.uploadFile(userId, folderId, file);
      uploadedFiles.push(uploadedFile as File);
    }

    res.status(201).json(uploadedFiles);
  } catch (error) {
    next(error);
  }
};

export const uploadFile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const bb = busboy({ headers: req.headers });
    const uploadPromises: Promise<any>[] = [];
    const { userId } = req.user as { userId: string };

    const userInfo = getUserInfo(req);
    const {
      ipAddress,
      userAgent,
      deviceType: device,
      operatingSystem,
      browser,
    } = userInfo;

    let folderId: string | null = null;
    let baseFolderPath = "";
    let fileRelativePath = "";

    bb.on("field", (name, val) => {
      if (name === "folderId") {
        folderId = val;
      }
      if (name === "relativePath") {
        fileRelativePath = val;
      }
    });

    bb.on("file", async (name, fileStream, info) => {
      const { filename, mimeType } = info;
      const relativePath = fileRelativePath ? fileRelativePath.split("/") : [];
      relativePath.pop();

      // Get folder path from the database
      if (folderId) {
        const folderResponse = await folderService.getFolderById(folderId);
        if (folderResponse) {
          baseFolderPath = folderResponse.folderPath as string;
        }
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });

      // If folder path is still empty, set default base path
      if (!baseFolderPath) {
        baseFolderPath = getBaseFolderPath(user?.email as string);
      }

      const fullPath = path.join(baseFolderPath, ...relativePath, filename);
      const fileUrl = `${
        process.env.PUBLIC_APP_URL
      }/cefmdrive/storage/${encodeURIComponent(
        user?.email as string
      )}/${encodeURIComponent(filename)}`;

      const writeStream = fs.createWriteStream(fullPath);
      fileStream.pipe(writeStream);

      uploadPromises.push(
        new Promise(async (resolve, reject) => {
          writeStream.on("finish", async () => {
            try {
              const stats = await fs.promises.stat(fullPath);

              // Check storage usage before saving the file
              const currentStorage = await prisma.storageHistory.findFirst({
                where: { userId: userId },
                orderBy: { createdAt: "desc" },
              });

              const newUsedStorage =
                (currentStorage?.usedStorage || 0) + stats.size;
              const maxStorageSize = (user?.maxStorageSize as number) || 0;

              if (newUsedStorage > maxStorageSize) {
                fs.unlinkSync(fullPath);
                return reject(
                  new Error("Storage limit exceeded. File not saved.")
                );
              }

              // Determine file type based on extension or mime type
              const extension = path.extname(filename).toLowerCase();
              const mimeTypes: { [key: string]: string } = {
                ".pdf": "Adobe Portable Document Format (PDF)",
                ".xlsx": "Microsoft Excel Spreadsheet (XLSX)",
                ".xls": "Microsoft Excel Spreadsheet (XLS)",
                ".png": "PNG Image",
                ".jpg": "JPEG Image",
                ".jpeg": "JPEG Image",
                ".doc": "Microsoft Word Document",
                ".docx": "Microsoft Word Document",
                ".ppt": "Microsoft PowerPoint Presentation",
                ".pptx": "Microsoft PowerPoint Presentation",
                ".txt": "Plain Text File",
                ".zip": "ZIP Archive",
                ".mp4": "Video File",
                ".mov": "Video File",
                ".avi": "Video File",
                ".mkv": "Video File",
                ".webm": "Video File",
                ".mp3": "Audio File",
                ".wav": "Audio File",
                ".aac": "Audio File",
                ".flac": "Audio File",
                ".ogg": "Audio File",
                ".m4a": "Audio File",
              };
              const fileType = mimeTypes[extension] || mimeType;

              if (!folderId) {
                const folder = await prisma.folder.findFirst({
                  where: { name: user?.email as string },
                });
                folderId = folder?.id || null;
              }

              const fileData = await prisma.file.create({
                data: {
                  name: filename,
                  filePath: fullPath,
                  fileUrl: fileUrl,
                  mimeType: mimeType,
                  size: stats.size,
                  userId: userId,
                  folderId: folderId,
                  fileType: fileType,
                },
              });

              // Log file activity
              await prisma.fileActivity.create({
                data: {
                  userId,
                  fileId: fileData.id,
                  activityType: "File",
                  action: "CREATE FILE",
                  ipAddress,
                  userAgent,
                  device,
                  operatingSystem,
                  browser,
                  filePath: fullPath,
                  fileSize: stats.size,
                  fileType: fileType,
                },
              });

              // Update storage history
              const totalStorage = user?.maxStorageSize || 0;
              const storageUsagePercentage =
                (newUsedStorage / Math.max(totalStorage, 1)) * 100;
              const overflowStorage = Math.max(
                0,
                newUsedStorage - totalStorage
              );

              await prisma.storageHistory.create({
                data: {
                  userId: userId,
                  usedStorage: newUsedStorage,
                  totalStorage: totalStorage,
                  storageType: "file",
                  storageLocation: baseFolderPath,
                  storageUsagePercentage: Math.min(storageUsagePercentage, 100),
                  storageLimit: totalStorage,
                  overflowStorage: overflowStorage,
                  notificationSent: storageUsagePercentage > 90,
                },
              });

              resolve(fileData);
            } catch (error) {
              reject(error);
            }
          });

          writeStream.on("error", (error) => {
            reject(error);
          });
        })
      );
    });

    bb.on("finish", async () => {
      try {
        const results = await Promise.all(uploadPromises);
        res.json({ message: "Files uploaded successfully", files: results });
      } catch (error: any) {
        if (error.message === "Storage limit exceeded. File not saved.") {
          res.status(400).json({ error: error.message });
        } else {
          res.status(500).json({ error: "Error uploading files" });
        }
      }
    });

    req.pipe(bb);
  } catch (error) {
    next(error);
  }
};

export const downloadFiles = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    logger.info("Starting file download process", {
      fileId: req.params.itemId,
    });

    const fileId = req.params.itemId as string;

    // Fetch the file from the database
    const file = await prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      logger.error("File not found in the database", { fileId });
      return res.status(404).json({ message: "File not found." });
    }

    const filePath = path.join(file.filePath as string);

    // Check if file exists on the server
    if (!fs.existsSync(filePath)) {
      logger.error("File not found on the server", { filePath });
      return res.status(404).json({ message: "File not found on the server." });
    }

    // // Log the file download action in fileActivity
    // await prisma.fileActivity.create({
    //     data: {
    //         userId: 'userId', // Replace this with dynamic userId from your auth system
    //         fileId: fileId,
    //         action: 'download file',
    //     },
    // });

    logger.info("File download action logged", { fileId });

    // Read the file stream
    const fileStream = fs.createReadStream(filePath);

    // Set appropriate headers
    const contentDisposition = file.mimeType.startsWith("image/")
      ? "inline"
      : "attachment";
    res.setHeader(
      "Content-Disposition",
      `${contentDisposition}; filename="${encodeURIComponent(file.name)}"`
    );
    res.setHeader("Content-Type", file.mimeType);

    // Pipe the file stream to the response
    fileStream.pipe(res);

    fileStream.on("end", () => {
      logger.info("File download successful", { fileId });
    });

    fileStream.on("error", (err) => {
      logger.error("Error while downloading file", {
        fileId,
        error: err.message,
      });
      next(err);
    });
  } catch (error) {
    logger.error("Error in downloadFiles function", {
      error: (error as Error).message,
    });
    next(error);
  }
};

export const downloadFile = async (req: Request, res: Response) => {
  const fileId = req.params.itemId as string;

  try {
    const file = await getFileById(fileId);

    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }

    const filePath = file.filePath as string;

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found on the server" });
    }

    // Determine the MIME type
    const mimeType = mime.lookup(filePath) || "application/octet-stream";

    // Get the file name and encode it for the Content-Disposition header
    const fileName = encodeURIComponent(path.basename(filePath));

    // Set the appropriate headers
    res.setHeader("Content-Type", mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${fileName}`
    );

    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.on("error", (error) => {
      console.error("Error streaming file:", error);
      res.status(500).json({ error: "Error streaming file" });
    });

    fileStream.pipe(res);
  } catch (error) {
    console.error("Error downloading file:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const createDocument = async (req: Request, res: Response) => {
  const fileId = req.params.itemId as string;

  try {
    res.status(201).json("Document created successfully!!!!!!");
  } catch (error) {
    console.error("Error downloading file:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const downloadFolder = async (req: Request, res: Response) => {
  const folderId = req.params.itemId as string;

  try {
    const folder = await folderService.getFolderById(folderId);

    if (!folder) {
      return res.status(404).json({ error: "Folder not found" });
    }

    const folderPath = folder.folderPath as string;

    if (!fs.existsSync(folderPath)) {
      logger.error(`Folder does not exist on the server, ${folderPath}`);
      return res
        .status(500)
        .json({ error: "Folder does not exist on the file system" });
    }

    const zipStream = await createZipFolder(folderPath);

    zipStream.pipe(res);
  } catch (error) {
    console.error("Error downloading folder:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const downloadFolders = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const folderId = req.params.itemId as string;

  logger.info("Request to download folder", { folderId });

  try {
    // Fetch folder data from the database
    const folder = await prisma.folder.findUnique({
      where: { id: folderId },
    });

    if (!folder) {
      logger.error("Folder not found in the database", { folderId });
      return res.status(404).json({ message: "Folder not found" });
    }

    // Define the folder path based on folderPath stored in the database
    const folderPath = path.join(folder.folderPath as string);

    logger.info("Folder path resolved", { folderId, folderPath });

    // Check if the folder exists on the file system
    if (!fs.existsSync(folderPath)) {
      logger.error("Folder does not exist on the server", { folderPath });
      return res
        .status(404)
        .json({ message: "Folder does not exist on the server" });
    }

    // Create a zip file
    const zipFileName = `${folder.name}.zip`;
    const zipFilePath = path.join(process.cwd(), zipFileName);
    // const zipFilePath = path.join(folderPath, zipFileName);
    const output = fs.createWriteStream(zipFilePath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      logger.info(`Zipped ${archive.pointer()} total bytes.`, {
        zipFileName,
        folderId,
      });
    });

    archive.on("error", (err) => {
      logger.error("Error occurred while zipping folder", {
        error: err.message,
      });
      throw err;
    });

    // Pipe the zip stream to the output file
    archive.pipe(output);

    // Append the folder and its subfolders/files to the archive
    archive.directory(folderPath, false);

    // Finalize the archive to finish the zip creation
    await archive.finalize();

    // Wait until the zip file is ready before streaming it to the client
    output.on("finish", async () => {
      logger.info("ZIP file creation completed", { zipFilePath });

      // Set response headers for downloading the zip file
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${zipFileName}"`
      );

      // Stream the zip file to the client
      const zipFileStream = fs.createReadStream(zipFilePath);
      zipFileStream.pipe(res);

      // Cleanup the zip file after download
      zipFileStream.on("end", () => {
        logger.info("ZIP file streamed to client, deleting file", {
          zipFilePath,
        });
        fs.unlinkSync(zipFilePath); // Delete the zip file from the server after streaming
      });

      // try {
      //     // Log the file download action in fileActivity
      //     await prisma.fileActivity.create({
      //         data: {
      //             userId: req.userId, // Make sure userId is dynamically passed from authentication
      //             fileId: folderId,
      //             action: 'download folder',
      //         },
      //     });
      // } catch (activityError) {
      //     logger.error('Error logging file activity', { error: activityError });
      // }
    });
  } catch (error) {
    logger.error("An error occurred while downloading the folder", {
      error: (error as Error).message,
    });
    next(error);
  }
};

export const deletePermanently = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };
  const { fileType, fileId } = req.params;

  try {
    await prisma.$transaction(async (prismaClient) => {
      if (fileType === "Document") {
        const document = await prismaClient.document.findUnique({
          where: { id: fileId },
        });
        if (!document) {
          throw new Error(`Document with ID ${fileId} not found.`);
        }
        await prismaClient.document.delete({
          where: { id: fileId },
        });
      } else if (fileType === "Folder") {
        const folder = await prismaClient.folder.findUnique({
          where: { id: fileId },
        });
        if (!folder) {
          throw new Error(`Folder with ID ${fileId} not found.`);
        }
        const folderPath = path.join(folder.folderPath as string);
        await fs.rm(folderPath, { recursive: true, force: true });
        await prismaClient.folder.delete({ where: { id: fileId } });
      } else if (fileType === "File") {
        const file = await prismaClient.file.findUnique({
          where: { id: fileId },
        });
        if (!file) {
          throw new Error(`File with ID ${fileId} not found.`);
        }
        const filePath = path.join(file.filePath as string);
        await fs.unlink(filePath);
        await prismaClient.file.delete({
          where: { id: fileId },
        });
      } else {
        throw new Error(`Invalid file type: ${fileType}`);
      }
    });

    return res
      .status(200)
      .json({ success: `${fileType} with ID ${fileId} deleted permanently.` });
  } catch (error) {
    logger.error("An error occurred while deleting the item", { error });
    if (error instanceof Error) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: "An unexpected error occurred" });
  }
};

export const restoreFile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { fileId } = req.params;
  const { userId } = req.user as { userId: string };

  try {
    const file = await prisma.file.findUnique({
      where: { id: fileId, userId: userId },
    });

    if (!file) {
      return res
        .status(404)
        .json({ error: `File with ID ${fileId} not found.` });
    }

    if (!file.trashed) {
      return res
        .status(400)
        .json({ error: `File with ID ${fileId} is not in trash.` });
    }

    const updatedFile = await prisma.file.update({
      where: { id: fileId },
      data: { trashed: false },
    });

    // Log file activity
    await prisma.fileActivity.create({
      data: {
        userId,
        fileId: updatedFile.id,
        activityType: "File",
        action: "RESTORE FILE",
        filePath: updatedFile.filePath as string,
        fileSize: updatedFile.size,
        fileType: updatedFile.fileType,
      },
    });

    return res.status(200).json({
      success: `File with ID ${fileId} restored`,
      file: updatedFile,
    });
  } catch (error) {
    console.error(`Error restoring file with ID ${fileId}:`, error);
    return next(new Error(`Failed to restore file with ID ${fileId}.`));
  }
};

const generatePreview = async (
  filePath: string,
  mimeType: string,
  email: string
): Promise<string | null> => {
  try {
    const previewDir = path.join(
      process.cwd(),
      "public",
      "File Manager",
      email,
      "previews"
    );

    // Ensure the preview directory exists using async methods
    await fs.mkdir(previewDir, { recursive: true });

    const previewFileName = `${path.basename(
      filePath,
      path.extname(filePath)
    )}_preview.png`;
    const previewPath = path.join(previewDir, previewFileName);

    if (mimeType.startsWith("image/")) {
      // Handle image preview generation using async/await
      await sharp(filePath)
        .resize({ width: 200, height: 200, fit: "inside" })
        .toFile(previewPath);
    } else if (mimeType === "application/pdf") {
      // Handle PDF preview generation
      const options = {
        density: 100,
        saveFilename: path.basename(filePath, path.extname(filePath)),
        savePath: previewDir,
        format: "png",
        width: 200,
        height: 200,
      };

      const pdfConverter = fromPath(filePath, options);
      await pdfConverter(1); // Convert first page to image

      // Handle the generated PDF image file
      const generatedFileName = `${options.saveFilename}.1.png`;
      const generatedFilePath = path.join(previewDir, generatedFileName);

      // Rename the generated PDF preview to match our naming convention
      await fs.rename(generatedFilePath, previewPath);
    } else {
      // Return null for unsupported file types
      return null;
    }

    // Return the path to the generated preview image
    return `/previews/${previewFileName}`;
  } catch (error) {
    console.error("Error generating preview:", error);
    return null;
  }
};

export const previewFile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const file = await prisma.file.findUnique({
      where: { id: String(req.params.fileId) },
      include: { user: true },
    });

    if (!file) {
      return res.status(404).json({ message: "File not found" });
    }

    // if (file.userId !== userId) {
    //     return res.status(403).json({ message: 'Access denied' })
    // }

    if (!fs.existsSync(file.filePath as string)) {
      return res.status(404).json({ error: "File not found on the server" });
    }

    //const filePath = path.join(process.cwd(), file.filePath as string)
    const filePath = path.join(file.filePath as string);
    const fileContent = fs.readFileSync(filePath);

    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${file.name}"`);
    res.send(fileContent);

    // const filePath = file.filePath as string;

    // // Set appropriate headers for preview
    // res.setHeader('Content-Type', file.mimeType);
    // res.sendFile(filePath);

    // res.json(file);
  } catch (error) {
    next(error);
  }
};

export const copyFile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    // const { newParentId } = req.body;

    const sourceFile = await prisma.file.findUnique({
      where: { id: req.params.id, userId: req.user!.id },
    });

    if (!sourceFile) {
      return res.status(404).json({ error: "File not found" });
    }

    // Fetch the user to calculate storage usage
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Generate a new filename for the copy
    const newFilename = `Copy of ${sourceFile.name}`;
    const newFilePath = path.join(
      path.dirname(sourceFile.filePath as string),
      newFilename
    );

    // Copy the file
    await fs.promises.copyFile(sourceFile.filePath as string, newFilePath);

    // Create a new file record in the database
    const copiedFile = await prisma.file.create({
      data: {
        name: newFilename,
        fileType: sourceFile.fileType,
        size: sourceFile.size,
        filePath: newFilePath,
        fileUrl: `${
          process.env.PUBLIC_APP_URL
        }/cefmdrive/storage/${encodeURIComponent(
          user.email as string
        )}/${encodeURIComponent(newFilename)}`,
        mimeType: sourceFile.mimeType,
        folderId: sourceFile.folderId,
        userId,
      },
    });

    // Log file activity
    await prisma.fileActivity.create({
      data: {
        userId,
        fileId: copiedFile.id,
        activityType: "File",
        action: "COPY FILE",
        filePath: copiedFile.filePath,
        fileSize: copiedFile.size,
        fileType: copiedFile.fileType,
      },
    });

    // Update storage history
    const totalStorage = user.maxStorageSize || 0;
    const usedStorage = await prisma.file.aggregate({
      _sum: { size: true },
      where: { userId },
    });
    const newUsedStorage = (usedStorage._sum.size || 0) + sourceFile.size;
    const storageUsagePercentage =
      (newUsedStorage / Math.max(totalStorage, 1)) * 100;

    await prisma.storageHistory.create({
      data: {
        userId,
        usedStorage: newUsedStorage,
        totalStorage,
        storageType: "file",
        storageLocation: copiedFile.filePath,
        storageUsagePercentage: Math.min(storageUsagePercentage, 100),
        storageLimit: totalStorage,
        overflowStorage: Math.max(0, newUsedStorage - totalStorage),
        notificationSent: storageUsagePercentage > 90,
      },
    });

    res.status(201).json(copiedFile);
  } catch (error) {
    console.error("Error copying file:", error);
    res.status(500).json({ error: "Error copying file" });
  }
};

export const getFiles = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { userId } = req.user as { userId: string };
    const { folderId } = req.query;

    const files = await fileService.getFiles(
      userId,
      folderId as string | undefined
    );
    res.json(files);
  } catch (error) {
    next(error);
  }
};

export const deleteFile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { userId } = req.user as { userId: string };
    const { fileId } = req.params;

    await fileService.deleteFile(userId, fileId);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const getDocuments = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };
  try {
    const document = await fileService.getDocuments(userId);

    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }
    res.json(document);
  } catch (error) {
    next(error);
  }
};

export const getCustomDocuments = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };
  try {
    const document = await fileService.getCustomDocuments(userId);

    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }
    res.json(document);
  } catch (error) {
    next(error);
  }
};

export const getShared = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };
  try {
    const document = await fileService.getShared(userId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }
    res.json(document);
  } catch (error) {
    next(error);
  }
};

export const getTrashed = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };
  try {
    const document = await fileService.getTrashed(userId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }
    res.json(document);
  } catch (error) {
    next(error);
  }
};

export const getPdf = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };
  try {
    const items = await fileService.getPDFFiles(userId);
    if (!items) {
      return res.status(404).json({ message: "Document not found" });
    }

    res.json(items);
  } catch (error) {
    next(error);
  }
};

export const getVideo = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };
  try {
    const files = await prisma.file.findMany({
      where: {
        fileType: "Video File",
        userId,
        trashed: false,
      },
    });

    if (!files) {
      return res.status(404).json({ message: "Video not found" });
    }
    res.json(files);
  } catch (error) {
    next(error);
  }
};

export const getAudio = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };
  try {
    const items = await fileService.getAudioFiles(userId);
    if (!items) {
      return res.status(404).json({ message: "Audio not found" });
    }
    res.json(items);
  } catch (error) {
    next(error);
  }
};

export const getWord = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };
  try {
    const document = await fileService.getWordFiles(userId);
    if (!document) {
      return res.status(404).json({ message: "Word not found" });
    }
    res.json(document);
  } catch (error) {
    next(error);
  }
};

export const getPhotos = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };
  try {
    const document = await fileService.getPhotos(userId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }
    res.json(document);
  } catch (error) {
    next(error);
  }
};

export const getExcelFiles = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };

  try {
    const document = await fileService.getExcelFiles(userId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }
    res.json(document);
  } catch (error) {
    next(error);
  }
};

export const getSharedWithMe = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };

  try {
    const document = await fileService.getSharedWithMe(userId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }
    res.json(document);
  } catch (error) {
    next(error);
  }
};

export const renameFile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };
  const { fileId } = req.params;
  const { newName } = req.body;

  try {
    const file = await fileService.renameFile(fileId, userId, newName);

    res.json(file);
  } catch (error) {
    next(error);
  }
};

export const getFileDetails = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { fileId } = req.params;

    const file = await fileService.getFileDetails(fileId);

    res.json(file);
  } catch (error) {
    next(error);
  }
};

export const lockFile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const file = await prisma.file.update({
      where: { id: req.params.id, userId: req.user!.id },
      data: { locked: true },
    });
    res.json(file);
  } catch (error) {
    res.status(500).json({ error: "Error locking file" });
    next(error);
  }
};

export const unlockFile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const file = await prisma.file.update({
      where: { id: req.params.id, userId: req.user!.id },
      data: { locked: false },
    });
    res.json(file);
  } catch (error) {
    res.status(500).json({ error: "Error unlocking file" });
    next(error);
  }
};

export const moveToTrash = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { userId } = req.user as { userId: string };
    const { fileId } = req.params;

    const file = await fileService.moveToTrash(fileId, userId);

    res.json(file);
  } catch (error) {
    next(error);
  }
};

export const shareLink = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId } = req.user as { userId: string };

  try {
    const file = await prisma.file.findUnique({
      where: { id: String(req.params.fileId) },
      include: { user: true },
    });

    if (!file) {
      return res.status(404).json({ message: "File not found" });
    }

    // if (file.userId !== userId) {
    //     return res.status(403).json({ message: 'Access denied' })
    // }

    const fileLink = `${process.env.PUBLIC_APP_URL}/api/files/preview/${file.id}`;
    res.status(200).json({ link: fileLink });
  } catch (error) {
    console.error("Error getting file link:", error);
    res.status(500).json({ message: "Error getting file link" });
  }
};

interface ShareableLinkEmailParams {
  toEmail: string;
  message?: string;
  fromEmail: string;
  shareableLink: string;
}

export const sharedFile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const encodedFileId = decodeFolder(req.params.fileId);

    // Find the shared file or folder record
    const sharedItem = await prisma.sharedFile.findFirst({
      where: { sharedUrl: encodedFileId },
    });

    if (!sharedItem) {
      console.log("File or folder not found.");
      return res.status(404).json({ message: "Item not found" });
    }

    // Check for expiration
    const currentDate = new Date();
    if (sharedItem.expirationDate && sharedItem.expirationDate < currentDate) {
      return res.status(400).json({ message: "The link has expired." });
    }

    // Check if the shared item is a file or folder
    if (sharedItem.shareableType) {
      if (sharedItem.shareableType === "File") {
        // Find the actual file in the database
        const file = await prisma.file.findUnique({
          where: { id: sharedItem.fileId as string },
        });

        if (!file) {
          return res.status(400).json({ message: "File record not found." });
        }

        // Prepare data to be returned
        const data = {
          name: file.name,
          size: file.size,
          mimeType: file.mimeType,
          itemId: file.id,
          isPasswordEnabled: sharedItem.isPasswordEnabled,
          shareableType: "File",
        };
        return res.status(200).json(data);
      }

      if (sharedItem.shareableType === "Folder") {
        // Find the actual folder in the database
        const folder = await prisma.folder.findUnique({
          where: { id: sharedItem.folderId as string },
        });

        if (!folder) {
          return res.status(400).json({ message: "Folder record not found." });
        }

        // Prepare data to be returned
        const data = {
          name: folder.name,
          size: folder.size,
          itemId: folder.id,
          isPasswordEnabled: sharedItem.isPasswordEnabled,
          shareableType: "Folder",
        };
        return res.status(200).json(data);
      }
    }

    return res.status(400).json({ message: "Invalid shareable type" });
  } catch (error) {
    console.error("Error fetching shared file/folder:", error);
    return next(error);
  }
};

export const copyLink = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { userId } = req.user as { userId: string };
    const { itemId } = req.params;

    const fileToShare = await fileService.shareLink(userId, itemId);

    res.json(fileToShare.url);
  } catch (error) {
    next(error);
  }
};

export const shareFile = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { userId } = req.user as { userId: string };
    const {
      fileId,
      sharedWith,
      password,
      expirationDate,
      shareWithMessage,
      isPasswordEnabled,
      isExpirationEnabled,
    } = req.body;

    const user = await userService.getUserById(userId);
    if (user) {
      const fileToShare = await fileService.shareFile(
        userId,
        fileId,
        password,
        sharedWith,
        shareWithMessage,
        isPasswordEnabled,
        expirationDate,
        isExpirationEnabled
      );
      if (fileToShare.url) {
        console.log(" ++++ shareFile user  fileToShare +++++ ");
        console.log(fileToShare);
        console.log(" ++++ shareFile user  fileToShare +++++ ");

        const emailParams = {
          toEmail: sharedWith,
          message: shareWithMessage,
          fromEmail: user.email,
          shareableLink: fileToShare.url,
        } as ShareableLinkEmailParams;

        await sendSharedLinkEmail(emailParams);
      }
    }

    res.json("success");
  } catch (error) {
    next(error);
  }
};

//TODO
// export const getAllFiles = async (req: Request, res: Response, next: NextFunction) => {
//     try {
//         const files = await prisma.file.findMany({
//             include: {
//                 owner: {
//                     select: {
//                         name: true,
//                     },
//                 },
//                 sharedWith: {
//                     select: {
//                         user: {
//                             select: {
//                                 name: true,
//                             },
//                         },
//                     },
//                 },
//             },
//         })

//         const formattedFiles = files.map((file) => ({
//             id: file.id,
//             name: file.name,
//             type: file.type,
//             size: file.size,
//             createdAt: file.createdAt,
//             updatedAt: file.updatedAt,
//             sharedWith: file.sharedWith.map((share) => share.user.name),
//             owner: file.owner.name,
//             mimeType: file.mimeType,
//         }))

//         res.json(formattedFiles)
//     } catch (error) {
//         console.error('Error fetching files:', error)
//         res.status(500).json({ error: 'Internal server error' })
//     }
// }
