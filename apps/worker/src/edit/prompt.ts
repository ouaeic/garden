/** Compact content anchors bind line addresses to the text the model intends to edit. */
export const EDIT_FORMAT_SPEC = `file_read shows N:TEXT. Address those line numbers.

  PUT 41.=42:
  -  if (!job) return null;
  +  if (!job) return undefined;
  +  return job.payload ?? undefined;

  PUT N:        replace line N
  PUT N.=M:     replace lines N to M
  PUT N*:       replace the block opening at line N
  PUT <N:       insert before line N
  PUT >N:       insert after line N
  CUT N.=M      delete lines N to M
  CUT N.=M @x   delete and hold as @x
  PUT >N @x     paste @x after line N

+ rows carry new text. Omit unchanged lines. PUT with no body deletes its range.

Every operation requires one - row first: the start of line N (8+ non-space characters, or the
whole line if shorter). CUT and paste destinations also require anchors. A whole old range works
too. Missing or mismatched anchors write nothing.

Ranges name the numbers you read, not those your earlier operations would leave, and must not
overlap. All operations on a file apply together or not at all, including repeated path entries.

Refusals return current text. Correct the anchor and patch before retrying.`;
