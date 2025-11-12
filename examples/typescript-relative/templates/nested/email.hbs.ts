import { sanitizeEmailHtml } from "../../sanitizeEmailHtml";

type EmailData = {
  body: string;
};

export default function buildEmail() {
  const data: EmailData = {
    body: "<strong>Preview</strong>",
  };

  return {
    data,
    postprocess: (html: string) => sanitizeEmailHtml(html),
  };
}
