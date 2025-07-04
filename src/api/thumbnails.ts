import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const file = formData.get("thumbnail");

  if (!(file instanceof File)) {
    throw new BadRequestError("thumbnail file missing");
  }

  const MAX_UPLOAD_SIZE = 10 << 20;
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail file too big");
  }

  const fileType = file.type;
  const arrayBuffer = await file.arrayBuffer();

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new BadRequestError("Video not found");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("User is not owner");
  }

  if (fileType !== "image/png" && fileType !== "image/jpeg") {
    throw new BadRequestError("Thumbnail file type are not supported");
  }
  const [type, subtype] = fileType.split("/");
  const filename = `${videoId}.${subtype}`;
  const filepath = path.join(cfg.assetsRoot, filename);

  await Bun.write(filepath, Buffer.from(arrayBuffer));

  const port = cfg.port;
  video.thumbnailURL = `http://localhost:${port}/assets/${filename}`;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
