import sanitizeHtml from "example-sanitizer";

type EmailData = {
  body: string;
};

export default function createEmailPreview() {
  const data: EmailData = {
    body: "<strong>Example</strong>",
  };

  return {
    data,
    postprocess: (html: string) => sanitizeHtml(html),
  };
}
