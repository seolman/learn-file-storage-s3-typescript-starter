import { respondWithJSON } from "./json";

import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import path from "path";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video", videoId, "by user", userID);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Video not found");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("User is not owner");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  const MAX_UPLOAD_SIZE = 1 << 30;
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video file too big");
  }

  const fileType = file.type;
  if (fileType !== "video/mp4") {
    throw new BadRequestError("Video file type are not supported");
  }

  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
  await Bun.write(tempFilePath, file);

  const randomHex = randomBytes(16).toString("hex");
  const aspectRatio = await getVideoAspectRatio(tempFilePath);

  const s3Key = `${aspectRatio}/${randomHex}.mp4`;
  const s3file = cfg.s3Client.file(s3Key, { bucket: cfg.s3Bucket });

  const processedFilePath = await processVideoForFastStart(tempFilePath);
  const videoFile = Bun.file(processedFilePath);

  await s3file.write(videoFile, { type: "video/mp4" });

  const videoURL = s3Key;
  video.videoURL = `${cfg.s3CfDistribution}/${videoURL}`;
  updateVideo(cfg.db, video);

  await Promise.all([rm(tempFilePath, { force: true }), rm(processedFilePath, { force: true })]);

  return respondWithJSON(200, video);
}


async function getVideoAspectRatio(filePath: string): Promise<"landscape" | "portrait" | "other"> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", `${filePath}`],
    { stdout: "pipe", stderr: "pipe" }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error("ffprobe failed:", stderr);
    throw new Error("Failed to analyze video file");
  }

  const parsed = JSON.parse(stdout);
  const streams = parsed.streams?.[0];
  if (!streams || !streams.width || !streams.height) {
    throw new Error("Invalid stream data");
  }

  const width = streams.width;
  const height = streams.height;
  const ratio = width / height;
  if (Math.abs(ratio - 16 / 9) < 0.1) return "landscape";
  if (Math.abs(ratio - 9 / 16) < 0.1) return "portrait";
  return "other";
}

async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = inputFilePath + "process.mp4";

  const proc = Bun.spawn(
    ["ffmpeg", "-i", inputFilePath, "-movflags", "faststart", "-map_metadata", "0", "-codec", "copy", "-f", "mp4", outputFilePath],
    { stdout: "pipe", stderr: "pipe" }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error("ffmpeg failed:", stderr);
    throw new Error("Failed to process video for faststart");
  }

  return outputFilePath;
}

export async function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number) {
  return cfg.s3Client.presign(`${key}`, { expiresIn: expireTime });
}

export async function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
  if (!video.videoURL) {
    return video;
  }
  video.videoURL = await generatePresignedURL(cfg, video.videoURL, 60 * 5);

  return video;
}
